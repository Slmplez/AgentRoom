These are publicly known, disposable TLS test credentials for loopback tests only.
Never import this certificate into an operating system trust store or use its private key for a real service.
The certificate contains only an IP SAN for 127.0.0.1 so hostname verification can be tested.

`persistence-v3.sql` and `persistence-v3-expected.json` contain synthetic discussion,
task, publication, receipt and event data generated using the original schema-3
runtime at `caaea30435ae5429e01002bbe98bff79eb8226f8`. They are migration fixtures,
not user data, model-quality evidence or credentials.
