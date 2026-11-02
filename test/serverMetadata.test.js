/**
 * Registry metadata for 0.8.2 (item 3).
 *
 * The registry caps `server.json.description` at 100 characters, and the
 * package entry must name the same version the root does. These are the two
 * values a directory reads before it ever connects, so they are asserted
 * against the release target rather than against whatever the file happens to
 * contain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'));

const server = read('server.json');
const pkg = read('package.json');

const REGISTRY_DESCRIPTION =
  'Validate emissions data against Open Footprint, check EU CBAM records, query verified methane data';

test('the registry description is the release copy and fits the 100-character cap', () => {
  assert.equal(server.description, REGISTRY_DESCRIPTION);
  assert.ok(server.description.length <= 100, `description is ${server.description.length} chars`);
  assert.equal(server.description.length, 98);
  assert.doesNotMatch(server.description, /\n/);
});

test('server.json and package.json agree on 0.8.2', () => {
  assert.equal(server.version, '0.8.2');
  assert.equal(pkg.version, '0.8.2');
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].version, pkg.version);
});

test('the registry keeps the stdio package and the hosted endpoint discoverable', () => {
  assert.equal(server.packages[0].identifier, '@dveracity/semantic-mcp');
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.remotes[0].url, 'https://api.dveracity.com/mcp');
});
