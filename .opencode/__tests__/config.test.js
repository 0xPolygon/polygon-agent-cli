/**
 * Tests for opencode configuration files
 * Run with: node .opencode/__tests__/config.test.js
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_DIR = join(__dirname, '..');

// Test results
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: ${expected}\n  Actual: ${actual}`);
  }
}

function assertTrue(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

console.log('Running opencode configuration tests...\n');

// Test 1: Main config.json exists and is valid JSON
test('config.json exists and is valid JSON', () => {
  const configPath = join(OPENCODE_DIR, 'config.json');
  const content = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);

  assertTrue(config.version, 'config.json should have a version');
  assertTrue(config.project, 'config.json should have a project field');
  assertTrue(config.project.name, 'config.json should have a project name');
  assertTrue(config.commands, 'config.json should have commands');
});

// Test 2: AGENTS.md exists
test('AGENTS.md exists at repository root', () => {
  const rootDir = join(OPENCODE_DIR, '..');
  const agentsPath = join(rootDir, 'AGENTS.md');
  const content = readFileSync(agentsPath, 'utf-8');

  assertTrue(content.length > 0, 'AGENTS.md should not be empty');
  assertTrue(content.includes('Polygon Agent CLI'), 'AGENTS.md should contain project name');
});

// Test 3: All task files are valid JSON
test('all task files are valid JSON', () => {
  const tasksDir = join(OPENCODE_DIR, 'tasks');
  const taskFiles = readdirSync(tasksDir).filter((f) => f.endsWith('.json'));

  assertTrue(taskFiles.length > 0, 'should have at least one task file');

  for (const file of taskFiles) {
    const content = readFileSync(join(tasksDir, file), 'utf-8');
    const task = JSON.parse(content);

    assertTrue(task.name, `Task ${file} should have a name`);
    assertTrue(task.description, `Task ${file} should have a description`);
    assertTrue(task.command, `Task ${file} should have a command`);
  }
});

// Test 4: All workflow files are valid JSON
test('all workflow files are valid JSON', () => {
  const workflowsDir = join(OPENCODE_DIR, 'workflows');
  const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.json'));

  assertTrue(workflowFiles.length > 0, 'should have at least one workflow file');

  for (const file of workflowFiles) {
    const content = readFileSync(join(workflowsDir, file), 'utf-8');
    const workflow = JSON.parse(content);

    assertTrue(workflow.name, `Workflow ${file} should have a name`);
    assertTrue(workflow.description, `Workflow ${file} should have a description`);

    // Workflows can be either task-based or interactive (prompt-based)
    const hasTasks = Array.isArray(workflow.tasks);
    const hasPrompt = typeof workflow.prompt === 'string';
    assertTrue(
      hasTasks || hasPrompt,
      `Workflow ${file} should have either tasks array or prompt string`
    );
  }
});

// Test 5: Tasks referenced in workflows exist
test('workflows reference existing tasks', () => {
  const tasksDir = join(OPENCODE_DIR, 'tasks');
  const workflowsDir = join(OPENCODE_DIR, 'workflows');

  const taskFiles = readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
  const taskNames = taskFiles.map((f) => {
    const content = readFileSync(join(tasksDir, f), 'utf-8');
    return JSON.parse(content).name;
  });

  const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.json'));

  for (const file of workflowFiles) {
    const content = readFileSync(join(workflowsDir, file), 'utf-8');
    const workflow = JSON.parse(content);

    if (workflow.tasks) {
      for (const taskName of workflow.tasks) {
        assertTrue(
          taskNames.includes(taskName),
          `Workflow ${file} references unknown task: ${taskName}`
        );
      }
    }
  }
});

// Test 6: README.md exists
test('README.md exists in .opencode directory', () => {
  const readmePath = join(OPENCODE_DIR, 'README.md');
  const content = readFileSync(readmePath, 'utf-8');

  assertTrue(content.length > 0, 'README.md should not be empty');
  assertTrue(content.includes('OpenCode Configuration'), 'README.md should have title');
});

// Summary
console.log('\n' + '='.repeat(50));
console.log(`Tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
