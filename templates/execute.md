Execute an Introsio Developer Mode project with the Introsio MCP tools, task by task, until it is done or nothing can start.

Project: $ARGUMENTS (a name or id — if empty, call getProjects and ask which Developer Mode project to run).

1. Start or resume: getProjectState { projectId } for the overview and the context revision, then getProjectContext { projectId } once. Work inside the context: use its tech stack, never cross a "must" constraint, follow its conventions, do not reopen accepted decisions (record a new one with recordProjectDecision).
2. Loop:
   a. claimTask { projectId, workerId } — use the SAME workerId on every call (the one claimTask returns, or the one the Introsio hook gave you). It hands you the spec, subtask waves, inputs (what earlier tasks produced) and, when the project has one, the GitHub repository.
   b. Do the work. For each subtask: updateSubtask { taskId, subtaskId, workerId, statusState: "in_progress" }, do it, then updateSubtask { …, completed: true }.
   c. Check it: run the tests or commands that prove it works.
   d. Commit it. If the claim named a repository: work on your own branch off its defaultBranch, push it, and record outcome.branch. Otherwise keep it local — commit only, no push.
   e. completeTask { taskId, workerId, outcome: { summary: what you produced (names, shapes, commit id), verification: what you ran and its result, files: paths you changed } }. If it is refused, fix exactly what the error names and call it again.
   f. The answer lists nowReady and openTasks — claim the next task. Do not re-read the schedule after every task.
3. If you cannot finish a task: updateTask { taskId, workerId, statusState: "blocked" } and tell the user why. Never leave a claimed task silently open.
4. When claimTask answers reason "complete" (or you have to stop): updateProjectState { projectId, handoff: true, execution: { description: where things stand, status: "done" | "paused" } }.
