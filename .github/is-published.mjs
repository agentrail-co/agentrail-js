import { spawnSync } from 'node:child_process';

const [name, version] = process.argv.slice(2);
const lookup = spawnSync('npm', ['view', name, 'versions', '--json'], {
  encoding: 'utf8',
});
if (lookup.error) throw lookup.error;
const result = JSON.parse(lookup.stdout);
if (lookup.status === 0)
  console.log((Array.isArray(result) ? result : [result]).includes(version));
else if (result.error?.code === 'E404')
  console.log(false); // The new Node package's first publication.
else {
  process.stderr.write(lookup.stderr);
  process.exit(lookup.status ?? 1);
}
