#!/usr/bin/env node
// Legacy entry point: Site configuration was merged into Domains in migration 0008.
console.error("Sites have been retired. Manage domain senders, quotas and templates in Domains, and credentials in API tokens. This command made no changes.");
process.exitCode = 1;
