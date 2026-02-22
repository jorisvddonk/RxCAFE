# Agents

ObservableCAFE supports two types of agents: hosted agents and connected agents.

## Overview

| Type | Runs In | Session Binding | Can Read Chunks | Can Write Chunks |
|------|---------|-----------------|-----------------|------------------|
| [Hosted Agents](./hosted-agents.md) | Server process | Exactly one per session | Yes | Yes |
| [Connected Agents](./connected-agents.md) | External process | Zero or more per session | Only when subscribed | Only when joined |

## Choosing an Agent Type

- **Hosted Agents**: Use when you need tight integration with the runtime, automatic session lifecycle management, and access to internal APIs.
- **Connected Agents**: Use when you need to run agents as separate processes, integrate external services, or need horizontal scaling.

## Quick Links

- [Hosted Agents](./hosted-agents.md) - Built-in agents that run in the server
- [Connected Agents](./connected-agents.md) - External agents connecting via REST API
