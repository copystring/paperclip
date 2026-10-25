/** Canonical definition and documentation for `create_task`. */
const delegationGuidance =
  " Every create_task call requires exactly one explicit nonempty assigneeActorId or assigneeUserId; include your own agent ID when assigning yourself. Resolve agent recipients with list_agents and people with list_people. For a named agent, use the exact returned ID or exact unique name, or an exact role/title match only when requested and unique. Never infer a recipient from the task title or a hardcoded mapping, and never change a requested recipient to yourself because another argument or tool call failed. If the requested recipient is absent or ambiguous, ask before creating. If a child needs this task's result, include this task's exact ID in the child's blockedByTaskIds. If this parent needs a child's result before finishing, use set_dependencies to add the child's exact ID to this parent's blockers, preserving existing blockers, and keep the parent open until it resolves; never make the child depend on its waiting parent. Independent review must use the configured review stage or another actor; a self-assigned child is not independent review. Verify the receipt's task ID and assignee before claiming the handoff succeeded; missing task or assignee data is unconfirmed.";
const createTaskDescription =
  "Create a project task from a conversation, or a child from an ordinary task. Persist initialPlan before execution. Set status to backlog when the user wants to save or plan work without starting it; backlog tasks never wake an agent. Omitted status means todo, subject to blockers." + delegationGuidance;

export const createTaskAction = {
  "id": "create_task",
  "canonical": {
    "operationId": "create_task",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "delegation_dependencies",
    "requiredClaims": [
      "delegation:tasks:create"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "issues.create / issues.createChild",
    "prpEvidence": "semantic-operation item event plus company-entity state diff and audit record",
    "prpBindingStatus": "bound",
    "legacyAliases": [
      "mcp:paperclipCreateIssue"
    ]
  },
  "documentation": {
    "title": "Create task",
    "description": createTaskDescription,
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "create_task",
      "input": {
        "idempotencyKey": "example",
        "title": "example",
        "assigneeActorId": "example-agent"
      }
    },
    "scenarioCall": {
      "operationId": "create_task",
      "idempotencyKey": "example",
      "input": {
        "title": "example",
        "assigneeActorId": "example-agent"
      }
    },
    "success": {
      "ok": true,
      "operationId": "create_task",
      "result": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ],
        "task": {
          "id": "example",
          "identifier": "EX-2",
          "parentId": "example-parent",
          "status": "todo",
          "assigneeActorId": "example-agent"
        }
      }
    }
  },
  "live": {
    "order": 22,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "create_task",
      "version": 1,
      "title": "Create task",
      "description": createTaskDescription,
      "exposure": "optional",
      "requiredClaims": [
        "delegation:tasks:create"
      ],
      "allowedModes": [
        "standard",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "idempotencyKey": {
            "type": "string",
            "description": "Caller-stable retry key.",
            "minLength": 1,
            "maxLength": 240
          },
          "title": {
            "type": "string",
            "description": "Child task title.",
            "minLength": 1,
            "maxLength": 500
          },
          "description": {
            "type": [
              "string",
              "null"
            ],
            "description": "Child task description.",
            "maxLength": 20000
          },
          "assigneeUserId": { "type": ["string", "null"], "description": "Company person ID from list_people. Mutually exclusive with assigneeActorId." },
          "assigneeActorId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Explicit nonempty agent ID from list_agents, including when assigning this agent.",
            "maxLength": 20000
          },
          "status": {
            "enum": ["backlog", "todo"],
            "description": "Initial status. Use backlog to save work without executing it. Defaults to todo (blocked when dependencies are unresolved)."
          },
          "priority": {
            "enum": [
              "critical",
              "high",
              "medium",
              "low"
            ]
          },
          "blockedByTaskIds": {
            "type": "array",
            "description": "Exact task IDs that must finish before this task starts. Include the predecessor ID when this task needs its result; do not infer blockers from titles or roles.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "projectId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Project ID for the task."
          },
          "initialPlan": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200000,
            "description": "Relevant markdown plan saved on the new task before execution starts."
          }
        },
        "required": ["idempotencyKey", "title"],
        "oneOf": [
          {
            "type": "object",
            "required": ["assigneeActorId"],
            "properties": {
              "assigneeActorId": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\S" },
              "assigneeUserId": { "type": "null" }
            }
          },
          {
            "type": "object",
            "required": ["assigneeUserId"],
            "properties": {
              "assigneeActorId": { "type": "null" },
              "assigneeUserId": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\S" }
            }
          }
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "commandId": {
            "type": "string",
            "description": "Stable command identifier.",
            "minLength": 1,
            "maxLength": 200
          },
          "disposition": {
            "enum": [
              "applied",
              "duplicate"
            ]
          },
          "stateRevision": {
            "type": "integer",
            "minimum": 0
          },
          "entityRefs": {
            "type": "array",
            "description": "Entities affected by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "scheduledWakeIds": {
            "type": "array",
            "description": "Wake identifiers scheduled by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "task": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "identifier": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "parentId": {
                "type": ["string", "null"],
                "minLength": 1
              },
              "projectId": {
                "type": ["string", "null"],
                "minLength": 1
              },
              "status": {
                "type": "string",
                "minLength": 1
              },
              "assigneeUserId": { "type": ["string", "null"], "description": "Company person ID from list_people. Mutually exclusive with assigneeActorId." },
          "assigneeActorId": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "commandId",
          "disposition",
          "stateRevision",
          "entityRefs",
          "scheduledWakeIds"
        ],
        "additionalProperties": false
      }
    }
  },
  "scenario": {
    "order": 18,
    "descriptor": {
      "operationId": "create_task",
      "version": 1,
      "title": "Create Task",
      "description": "Create Task through the Capability delegation dependencies capability set." + delegationGuidance,
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string"
          },
          "assigneeActorId": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "description": "Explicit agent ID, including this agent when self-assigning."
          },
          "status": {
            "enum": ["backlog", "todo"],
            "description": "Initial status. Use backlog to save work without executing it. Defaults to todo (blocked when dependencies are unresolved)."
          },
          "priority": {
            "type": "string"
          },
          "blockedByTaskIds": {
            "type": "array",
            "description": "Exact task IDs that must finish before this task starts. Include the predecessor ID when this task needs its result; do not infer blockers from titles or roles.",
            "items": {
              "type": "string"
            }
          }
        },
        "required": ["title", "assigneeActorId"],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "schema": {
            "type": "string",
            "enum": [
              "paperclip.capability.tool-result.v1"
            ]
          },
          "ok": {
            "type": "boolean"
          },
          "operationId": {
            "const": "create_task"
          },
          "operationResultId": {
            "type": "string",
            "minLength": 1
          },
          "value": {
            "type": ["object", "array", "string", "number", "boolean", "null"],
            "properties": {
              "task": {
                "type": "object",
                "description": "Optional task details. When present, check task.id and the returned assignee before claiming delegation succeeded; missing task or assignee data is unconfirmed.",
                "properties": {
                  "id": { "type": "string" },
                  "identifier": { "type": ["string", "null"] },
                  "parentId": { "type": ["string", "null"] },
                  "projectId": { "type": ["string", "null"] },
                  "status": { "type": "string" },
                  "assigneeActorId": { "type": ["string", "null"], "description": "Assigned agent ID; compare with the explicitly requested recipient." },
                  "assigneeUserId": { "type": ["string", "null"] }
                },
                "additionalProperties": true
              }
            },
            "additionalProperties": true
          },
          "commandResult": {},
          "authorization": {}
        },
        "required": [
          "schema",
          "ok",
          "operationId",
          "operationResultId",
          "value",
          "commandResult",
          "authorization"
        ],
        "additionalProperties": false
      },
      "disposition": "optional_agent_tool",
      "optionalGroup": "delegation_dependencies",
      "requiredClaims": [
        "delegation:tasks:create"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "company_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "create_task"
      }
    }
  }
} as const;
