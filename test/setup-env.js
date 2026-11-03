// Every spec starts without Redis/Valkey connection settings from the shell or
// the CI host, so the connection a spec expects depends only on what it sets.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('CACHE_VALKEY_')) delete process.env[name];
}
