# 0006 — Explicit task-scoped subagent authorization

Status: feature branch, not deployed.

## Decision

The composer sends a mode with each ordinary prompt: single (default), approval, or auto. Missing or invalid modes never grant permission. The server activates the built-in tools only for an explicitly authorized task and revokes the grant when the prompt completes or its wrapper is destroyed. Approval mode requires an actual UI confirmation before every dispatch/resume. Background children already executing may finish; queued work must pass authorization again before starting.

The older builtInEnabled setting is left disabled in the live configuration to protect the independently installed older Web server. The new branch registers the host extension internally and gates use by task mode instead. The old global settings UI therefore needs a labeling/kill-switch migration before production rollout. No mode grants permission to use a premium model. The P0 budget is four dispatches (including resumes) per session, persisted using atomic slots, at most two concurrent children per parent, twelve turns per dispatch, and only the approved role models. Profile-defined reasoning cannot exceed medium. Ordinary CLI remains single-agent; the separate local CLI installation is outside this repository.

## Maintenance and rollout

Develop and test in a dedicated Git worktree/feature branch; do not stage unrelated working-tree changes. Keep runtime policy and user configuration outside Git (no credentials, session files, grant lists, logs, or budget state). Tests use fake providers and temporary policy directories. Review the branch diff and run the focused regression suite plus TypeScript before merging. Keep the current deployment on P0 until browser approval, task lifecycle, older-server isolation, and settings behavior are verified. Deployment requires a clean merge/integration with the existing local changes and an idle service window. Roll back by reverting the feature commits, not by resetting the live checkout.

This is a dispatch guard, not an operating-system sandbox against arbitrary shell execution.
