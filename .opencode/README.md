# OpenCode Configuration

This directory contains the opencode configuration for the Polygon Agent CLI project.

## Structure

```
.opencode/
├── config.json          # Main configuration file
├── README.md           # This file
├── tasks/              # Reusable task definitions
│   ├── build.json
│   ├── typecheck.json
│   ├── lint.json
│   └── cli-dev.json
└── workflows/          # Workflow compositions
    ├── ci.json
    └── new-command.json
```

## Usage

### Running Tasks

Tasks can be executed individually:

```bash
# Build all packages
opencode task build

# Run type checking
opencode task typecheck

# Run linting
opencode task lint

# Run CLI in dev mode
opencode task cli-dev
```

### Running Workflows

Workflows combine multiple tasks:

```bash
# Run full CI pipeline
opencode workflow ci

# Create a new command (interactive)
opencode workflow new-command
```

## Updating Configuration

### Adding New Tasks

1. Create a new JSON file in `.opencode/tasks/`
2. Follow the schema:
   ```json
   {
     "name": "task-name",
     "description": "What this task does",
     "command": "pnpm run command",
     "cwd": "${workspaceRoot}",
     "group": "category"
   }
   ```
3. Reference in workflows as needed

### Adding New Workflows

1. Create a new JSON file in `.opencode/workflows/`
2. Follow the schema:
   ```json
   {
     "name": "workflow-name",
     "description": "What this workflow does",
     "tasks": ["task1", "task2"],
     "sequential": true
   }
   ```

### Modifying AGENTS.md

The `AGENTS.md` file at the repository root contains instructions for AI agents. Update it when:
- Project structure changes
- New commands are added
- Development workflows change
- Important conventions are established

## Configuration Reference

### config.json

- `version`: Configuration version
- `project`: Project metadata
- `commands`: Shortcut commands for common operations
- `include`: Files to include in context
- `exclude`: Files to exclude from context

### Task Schema

- `name`: Unique task identifier
- `description`: Human-readable description
- `command`: Shell command to execute
- `cwd`: Working directory (use `${workspaceRoot}` for repo root)
- `group`: Category for organization

### Workflow Schema

- `name`: Unique workflow identifier
- `description`: Human-readable description
- `tasks`: Array of task names to execute
- `sequential`: Whether to run tasks in order (true) or parallel (false)
