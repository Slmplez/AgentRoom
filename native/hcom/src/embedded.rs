//! Agent Room host API. One Node utility process owns at most one PTY.
//! hcom's process-local identity/exit globals are never shared by two sessions.
use std::{cell::Cell, io::Write, sync::{Mutex, OnceLock, mpsc}, time::Duration};
use base64::Engine;
use napi::{JsFunction, bindgen_prelude::Buffer, threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode}};
use napi_derive::napi;
use serde_json::{Value, json};
use crate::{config::Config, db::HcomDb};

thread_local! { static PLANNING: Cell<bool> = const { Cell::new(false) }; }
pub fn is_planning() -> bool { PLANNING.with(Cell::get) }
struct PlanningGuard;
impl Drop for PlanningGuard { fn drop(&mut self) { PLANNING.with(|p| p.set(false)); } }
fn error(e: impl std::fmt::Display) -> napi::Error { napi::Error::from_reason(e.to_string()) }

#[napi]
pub fn initialize() -> napi::Result<String> {
    if std::env::var_os("HCOM_DIR").is_none() { return Err(error("HCOM_DIR must be private and explicit")); }
    Config::init();
    crate::paths::ensure_hcom_directories_at(&Config::get().hcom_dir);
    HcomDb::open().map_err(error)?;
    Ok(json!({"version":env!("CARGO_PKG_VERSION"),"core":"native","protocol":1}).to_string())
}

#[napi]
pub fn snapshot() -> napi::Result<String> {
    let db = HcomDb::open().map_err(error)?;
    let mut agents = Vec::new();
    for mut agent in db.iter_instances().map_err(error)? {
        let Some(name) = agent["name"].as_str().map(str::to_string) else { continue };
        if !agent["launch_context"].as_str().unwrap_or("").contains("agent-room-rpc") {
          if let Some(row) = db.get_instance_full(&name).map_err(error)? {
            let status = crate::instance_lifecycle::get_instance_status(&row, &db);
            agent["status"] = json!(status.status);
          }
        }
        let tag = agent["tag"].as_str().unwrap_or("").to_string();
        agent["base_name"] = json!(name);
        agent["name"] = json!(if tag.is_empty() { name.clone() } else { format!("{tag}-{name}") });
        agent["hooks_bound"] = json!(db.has_session_binding(&name));
        agent["process_bound"] = json!(db.has_process_binding_for_instance(&name));
        agents.push(agent);
    }
    let mut stmt = db.conn().prepare("SELECT id,timestamp,type,data FROM events WHERE type='message' ORDER BY id DESC LIMIT 500").map_err(error)?;
    let mut events: Vec<Value> = stmt.query_map([], |r| {
        let data: String = r.get(3)?;
        Ok(json!({"id":r.get::<_,i64>(0)?,"ts":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"data":serde_json::from_str::<Value>(&data).unwrap_or(Value::Null)}))
    }).map_err(error)?.collect::<Result<_,_>>().map_err(error)?;
    events.reverse();
    Ok(json!({"agents":agents,"events":events}).to_string())
}

#[napi]
pub fn engines() -> String {
    json!(["codex","claude","pi","opencode"].iter().map(|tool| json!({"id":tool,"installed":crate::terminal::which_bin(tool).is_some(),"hookMode":"per-session"})).collect::<Vec<_>>()).to_string()
}

/// RPC agents use the same durable hcom bus, without installing TUI hooks or a PTY.
#[napi]
pub fn rpc_register(payload: String) -> napi::Result<String> {
    let p: Value = serde_json::from_str(&payload).map_err(error)?;
    let tool = p["tool"].as_str().ok_or_else(||error("Missing tool"))?;
    if !["codex","claude","pi","opencode"].contains(&tool) { return Err(error("Unsupported RPC engine")); }
    let db = HcomDb::open().map_err(error)?;
    let name = crate::instance_names::generate_unique_name(&db).map_err(error)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(error)?.as_secs_f64();
    let cursor: i64 = db.conn().query_row("SELECT COALESCE(MAX(id),0) FROM events",[],|r|r.get(0)).map_err(error)?;
    let data = json!({"tool":tool,"directory":p["directory"],"tag":p["tag"],"created_at":now,
        "session_id":p["sessionId"],"pid":p["pid"],"background":1,"status":"listening","status_time":now as i64,
        "last_seen":now as i64,"last_event_id":cursor,"status_context":"rpc:idle","launch_context":"agent-room-rpc"});
    // generate_unique_name already reserves the row under the upstream name lock.
    db.update_instance_fields(&name,data.as_object().unwrap()).map_err(error)?;
    Ok(json!({"instance_name":name}).to_string())
}

#[napi]
pub fn rpc_update(payload: String) -> napi::Result<String> {
    let p: Value = serde_json::from_str(&payload).map_err(error)?;
    let db = HcomDb::open().map_err(error)?;
    let name = p["name"].as_str().ok_or_else(||error("Missing name"))?;
    let status = p["status"].as_str().ok_or_else(||error("Missing status"))?;
    if !["listening","active","blocked","inactive"].contains(&status) { return Err(error("Invalid status")); }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(error)?.as_secs() as i64;
    db.conn().execute("UPDATE instances SET status=?,status_time=?,last_seen=?,status_detail=? WHERE name=? AND session_id=? AND launch_context='agent-room-rpc'",
        rusqlite::params![status,now,now,p["detail"].as_str().unwrap_or(""),name,p["sessionId"].as_str()]).map_err(error)?;
    Ok("{}".into())
}

#[napi]
pub fn rpc_inbox(name: String) -> napi::Result<String> {
    let db=HcomDb::open().map_err(error)?;
    let messages=db.try_get_unread_messages(&name).map_err(error)?;
    Ok(json!(messages.iter().map(|m|json!({"id":m.event_id,"from":m.from,"text":m.text,"thread":m.thread})).collect::<Vec<_>>()).to_string())
}

#[napi]
pub fn rpc_ack(payload: String) -> napi::Result<String> {
    let p:Value=serde_json::from_str(&payload).map_err(error)?;
    let db=HcomDb::open().map_err(error)?;
    let name=p["name"].as_str().ok_or_else(||error("Missing name"))?;
    db.advance_instance_cursor(name,p["id"].as_i64().ok_or_else(||error("Missing id"))?).map_err(error)?;
    db.log_event("rpc_delivery",name,&json!({"message_id":p["id"],"state":"dispatching","retry":"manual"})).map_err(error)?;
    Ok("{}".into())
}

#[napi]
pub fn rpc_reply(payload: String) -> napi::Result<String> {
    let p:Value=serde_json::from_str(&payload).map_err(error)?;
    let name=p["name"].as_str().ok_or_else(||error("Missing name"))?;
    let db=HcomDb::open().map_err(error)?;
    let row=db.get_instance_full(name).map_err(error)?.ok_or_else(||error("Unknown RPC agent"))?;
    if row.session_id.as_deref()!=p["sessionId"].as_str() {return Err(error("RPC identity mismatch"));}
    // A displayed response has no recipients. Only explicit hcom sends trigger other agents.
    let data=json!({"from":name,"sender_kind":"instance","text":p["text"],"intent":"inform",
        "thread":p["thread"],"reply_to":p["replyTo"],"scope":"mentions","mentions":[],"delivered_to":[]});
    let id=db.log_event("message",name,&data).map_err(error)?;
    Ok(json!({"event_id":id}).to_string())
}

#[napi]
pub fn prepare_launch(payload: String) -> napi::Result<String> {
    let p: Value = serde_json::from_str(&payload).map_err(error)?;
    let tool = p["tool"].as_str().ok_or_else(|| error("Missing tool"))?;
    if !["codex","claude","pi","opencode"].contains(&tool) { return Err(error("Unsupported embedded engine")); }
    let args: Vec<String> = serde_json::from_value(p["args"].clone()).map_err(error)?;
    let env = serde_json::from_value(p["env"].clone()).map_err(error)?;
    let mut params = crate::launcher::LaunchParams::default();
    params.tool = tool.into(); params.args = args; params.env = Some(env);
    params.cwd = Some(p["directory"].as_str().ok_or_else(||error("Missing directory"))?.into());
    params.tag = p["tag"].as_str().filter(|s|!s.is_empty()).map(str::to_string);
    params.launcher = Some("agent-room".into()); params.background = true;
    PLANNING.with(|p|p.set(true)); let _guard = PlanningGuard;
    let result = crate::launcher::launch(&HcomDb::open().map_err(error)?,params).map_err(error)?;
    serde_json::to_string(&result).map_err(error)
}

#[napi]
pub fn send(payload: String) -> napi::Result<String> {
    let p: Value = serde_json::from_str(&payload).map_err(error)?;
    let targets: Vec<String> = serde_json::from_value(p["targets"].clone()).map_err(error)?;
    if targets.is_empty() { return Err(error("Explicit recipients required")); }
    let identity = crate::shared::SenderIdentity { kind: crate::shared::SenderKind::External, name:"user".into(), instance_data:None, session_id:None };
    let envelope = crate::messages::MessageEnvelope { intent:Some(crate::messages::MessageIntent::Request),thread:p["thread"].as_str().map(str::to_string),reply_to:None,bundle_id:None };
    let (id, recipients) = crate::commands::send::send_message(&HcomDb::open().map_err(error)?,&identity,p["text"].as_str().ok_or_else(||error("Missing text"))?,Some(&envelope),Some(&targets)).map_err(error)?;
    Ok(json!({"event_id":id,"delivered_to":recipients}).to_string())
}

#[napi]
pub fn watch(callback: JsFunction) -> napi::Result<()> {
    let callback: ThreadsafeFunction<String, ErrorStrategy::Fatal> = callback.create_threadsafe_function(8, |ctx| Ok(vec![ctx.value]))?;
    std::thread::spawn(move || {
        let Ok(db) = HcomDb::open() else { return };
        let Ok(notify) = crate::notify::NotifyServer::new() else { return };
        let _ = db.upsert_notify_endpoint("agent-room-ui","events_wait",notify.port());
        let mut previous = String::new();
        loop {
            if let Ok(state) = snapshot() {
                if state != previous { previous = state.clone(); callback.call(state,ThreadsafeFunctionCallMode::Blocking); }
            }
            // Notifications are a hint; bounded reconciliation covers status-only writes and missed wakes.
            notify.wait(Duration::from_secs(1));
        }
    });
    Ok(())
}

pub enum Input { Bytes(Vec<u8>), Resize(u16,u16), Stop }
static INPUT: OnceLock<mpsc::SyncSender<Input>> = OnceLock::new();
static INPUT_RX: Mutex<Option<mpsc::Receiver<Input>>> = Mutex::new(None);
static OUTPUT: OnceLock<mpsc::SyncSender<String>> = OnceLock::new();
pub fn input_receiver() -> Option<mpsc::Receiver<Input>> { INPUT_RX.lock().ok()?.take() }
pub fn emit(event: Value) { if let Some(tx)=OUTPUT.get() { let _=tx.send(event.to_string()); } }
pub fn exited(code:i32) { emit(json!({"type":"exit","code":code})); }
pub struct Output;
impl Write for Output {
    fn write(&mut self, bytes:&[u8]) -> std::io::Result<usize> {
        emit(json!({"type":"output","data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
        Ok(bytes.len())
    }
    fn flush(&mut self)->std::io::Result<()> { Ok(()) }
}

#[napi]
pub fn start_session(tool:String,args:Vec<String>,callback:JsFunction) -> napi::Result<()> {
    let (tx,rx)=mpsc::sync_channel(128);
    INPUT.set(tx).map_err(|_|error("One PTY per utility process"))?;
    *INPUT_RX.lock().map_err(error)?=Some(rx);
    let callback:ThreadsafeFunction<String,ErrorStrategy::Fatal>=callback.create_threadsafe_function(64,|ctx|Ok(vec![ctx.value]))?;
    let (out_tx,out_rx)=mpsc::sync_channel(256); OUTPUT.set(out_tx).map_err(|_|error("Session already started"))?;
    std::thread::spawn(move|| { for event in out_rx { if callback.call(event,ThreadsafeFunctionCallMode::Blocking)!=napi::Status::Ok { break; } } });
    std::thread::spawn(move|| {
        let mut argv=vec![tool]; argv.extend(args);
        if let Err(e)=crate::run_pty(&argv) { emit(json!({"type":"error","message":format!("{e:#}")})); exited(1); }
    });
    Ok(())
}
fn input(command:Input)->napi::Result<()> {
    INPUT.get().ok_or_else(||error("No running session"))?.try_send(command).map_err(error)
}
#[napi]
pub fn write_input(bytes:Buffer)->napi::Result<()> { if bytes.len()>65536 {return Err(error("Input too large"));} input(Input::Bytes(bytes.to_vec())) }
#[napi]
pub fn resize(cols:u32,rows:u32)->napi::Result<()> { if !(2..=500).contains(&cols)||!(2..=300).contains(&rows) {return Err(error("Invalid terminal dimensions"));} input(Input::Resize(cols as u16,rows as u16)) }
#[napi]
pub fn stop()->napi::Result<()> {input(Input::Stop)}
