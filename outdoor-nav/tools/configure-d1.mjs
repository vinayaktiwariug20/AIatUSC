import {readFileSync, writeFileSync} from 'node:fs';
const id = process.argv[2];
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error('Usage: npm run db:bind -- <actual database_id from Cloudflare>'); process.exit(1);
}
const file = new URL('../wrangler.jsonc',import.meta.url), config = JSON.parse(readFileSync(file,'utf8'));
config.d1_databases ??= [];
const existing = config.d1_databases.find(b => b.binding === 'DB');
if (existing && existing.database_id.toLowerCase() !== id.toLowerCase()) {
  console.error('DB is already bound to a different database. Review wrangler.jsonc first.'); process.exit(1);
}
const binding = {binding:'DB',database_name:'aiatusc-closures',database_id:id.toLowerCase(),migrations_dir:'migrations'};
if (existing) Object.assign(existing,binding); else config.d1_databases.push(binding);
writeFileSync(file,JSON.stringify(config,null,2)+'\n');
console.log('DB binding configured. Next: npm run db:local, then npm run db:remote, then npm run deploy.');
