'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTranscript } = require('../../src/core/transcripts');
const { transcript, U } = require('./helpers');

test('streamed assistant messages repeating the same usage are counted once', () => {
  const text = transcript({ sessionId: 'a1', turns: [
    { prompt: 'fix the bug', usage: U(10, 100), tools: [{ name: 'Read', input: { file_path: '/work/proj/a.js' } }] },
  ] });
  const { usageEntries, session } = parseTranscript(text);
  assert.equal(usageEntries.length, 1);
  assert.equal(session.turns.assistant, 1);
});

test('extracts prompts, files, commands, errors and last reply', () => {
  const text = transcript({ sessionId: 'a2', turns: [
    { prompt: 'add tests', usage: U(1, 1), tools: [
      { name: 'Edit', input: { file_path: '/work/proj/src/x.ts', old_string: 'a', new_string: 'b' } },
      { name: 'Bash', input: { command: 'npm test' }, error: 'Error: 2 failing' },
    ] },
    { prompt: '<command-name>/clear</command-name>', usage: U(1, 1) },
    { prompt: 'ship it', usage: U(1, 1), reply: 'Shipped.' },
  ] });
  const { session } = parseTranscript(text);
  assert.equal(session.id, 'a2');
  assert.equal(session.projectPath, '/work/proj');
  assert.deepEqual(session.prompts.map((p) => p.text), ['add tests', 'ship it']);
  assert.deepEqual(session.files['/work/proj/src/x.ts'], { read: 0, edit: 1, write: 0 });
  assert.equal(session.commands[0].cmd, 'npm test');
  assert.equal(session.errors.length, 1);
  assert.equal(session.errors[0].tool, 'Bash');
  assert.equal(session.lastAssistantText, 'Shipped.');
  assert.equal(session.title, 'add tests');
});

test('summary lines become the session title', () => {
  const { session } = parseTranscript(transcript({ summary: 'Checkout rewrite', turns: [{ prompt: 'x', usage: U(1, 1) }] }));
  assert.equal(session.title, 'Checkout rewrite');
});

test('malformed lines are skipped, not fatal', () => {
  const text = '{bad json\n' + transcript({ turns: [{ prompt: 'hello', usage: U(1, 2) }] }) + 'garbage\n';
  const { usageEntries } = parseTranscript(text);
  assert.equal(usageEntries.length, 1);
});

test('replay events include user, assistant, tool use and tool results', () => {
  const text = transcript({ turns: [{ prompt: 'go', usage: U(1, 1), tools: [{ name: 'Bash', input: { command: 'ls' } }] }] });
  const { events } = parseTranscript(text, { events: true });
  assert.deepEqual(events.map((e) => e.kind), ['text', 'text', 'tool_use', 'tool_result']);
  assert.equal(events[2].text, '$ ls');
});
