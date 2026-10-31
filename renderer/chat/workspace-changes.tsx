import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createWorkspaceChangesController } from '../client/workspace-changes.mjs';
import { DiffPreview, type WorkspaceChange } from './diff-preview';
import type { ReviewClient } from './review-diff-file';

// Mount only after the user chooses Workspace changes and the host grants review capability.
export function WorkspaceChanges({review,close,theme,returnFocus}:{review:ReviewClient;close():void;theme:string;returnFocus?:HTMLElement|null}) {
 const model=useMemo(()=>createWorkspaceChangesController(review),[review]);
 const state=useSyncExternalStore(model.subscribe,model.read);
 useEffect(()=>{model.activate();void model.refresh();return()=>model.close();},[model]);
 const files=useMemo(()=>state.result?.type==='changes'?state.result.files:[],[state.result]) as WorkspaceChange[];
 const patches=useMemo(()=>files.flatMap(file=>file.patch?[file.patch]:[]),[files]);
 return <DiffPreview patches={patches} changes={files} review={review} theme={theme} close={close} returnFocus={returnFocus} refreshing={state.loading} loadError={state.error} refresh={()=>void model.refresh()}/>;
}
