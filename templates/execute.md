Execute an Introsio Developer Mode project with the Introsio MCP tools, task by task, until it is done or nothing can start.

Project: $ARGUMENTS (a name or id — if empty, call getProjects and ask which Developer Mode project to run).

1. Start or resume: getProjectState { projectId } for the overview and the context revision, then getProjectContext { projectId } once. Work inside the context: use its tech stack, never cross a "must" constraint, follow its conventions, do not reopen accepted decisions (record a new one with recordProjectDecision).
2. Loop:
   a. claimTask { projectId, workerId } — use the SAME workerId on every call (the one claimTask returns, or the one the Introsio hook gave you). It hands you the spec, subtask waves, inputs (what earlier tasks produced) and, when the project has one, the GitHub repository.
      Start from the code you build on: each inputs[].outcome.branch must be in your branch before you write anything. If the claim named a repository: git fetch origin, branch off its defaultBranch, then git merge --no-edit origin/<branch> for each input branch. Otherwise merge each input branch that is not already in your current branch (git merge-base --is-ancestor <branch> HEAD tells you). Resolve conflicts; if you cannot, mark the task blocked (step 3).
   b. Do the work, one subtask at a time in the order of subtaskWaves, and report the steps you FINISH — never one you did not do:
      - A task you will finish well inside the lease (leaseExpiresAt in the claim, 30 minutes by default): make no call per step. Name every finished subtask in step e: completeTask { …, completedSubtasks: [ids] }.
      - A longer task: updateSubtask { taskId, subtaskId, workerId, completed: true } as each step finishes — one call, no in_progress first. It saves your progress if the session ends and renews the lease.
      - Only when several workers share one task: mark a subtask in_progress before you start it, so they see it is taken.
   c. Check it: run the tests or commands that prove it works.
   d. Commit it. If the claim named a repository: work on your own branch (step a), push it, and record outcome.branch. Otherwise keep it local — commit only, no push — and still record outcome.branch (your current branch), so the tasks that build on yours can merge it.
   e. completeTask { taskId, workerId, completedSubtasks: [the subtasks you finished and have not reported], outcome: { summary: what you produced (names, shapes, commit id), verification: what you ran and its result, files: paths you changed } }. If it is refused, fix exactly what the error names and call it again.
      Size the outcome to the task, not to a template: a small change is one line ("Renamed X to Y — abc1234"); a task that later tasks build on adds only the names and shapes they need (endpoints, exports, schema fields, decisions). Never narrate the steps you took, repeat the spec, or list what files already shows. verification is the command and its result in one line.
      The outcome is the record — do not also write a recap in chat. Between tasks say at most one short line ("Done: <title>") and claim the next one; save the wrap-up for when the project is done or you stop.
   f. The answer lists nowReady and openTasks — claim the next task. Do not re-read the schedule after every task.
   g. An integration task (its inputs name several branches) merges ALL of them into one branch, runs the whole test suite, and fixes what breaks between the pieces — its outcome names the merged branch and the full test result.
3. If you cannot finish a task: updateTask { taskId, workerId, statusState: "blocked" } and tell the user why. Never leave a claimed task silently open.
4. When claimTask has nothing for you, its reason says why:
   - "all_claimed" (other workers hold the ready work) or "awaiting_completion" (tasks report their phase done but are not completed — completeTask any you hold): do NOT stop. Wait, then claimTask again: run `int wait <retryAfter>` in a shell (it returns after at most 4 minutes; without the int command, wait the same way your tools allow), and repeat. What the other workers finish unlocks your next task. After an hour of waiting with no task, tell the user what is still held and stop.
   - "complete": updateProjectState { projectId, handoff: true, execution: { description: where things stand, status: "done" } }.
   - "paused": the rest of the ready work is paused — tell the user (/introsio-resume takes a paused task back after checking the repository); never claim a paused task without resume: true.
   - "blocked": tell the user which tasks are blocked and why nothing else can start.
5. If you have to stop before the project is done — out of usage, context or time, or the user asks — follow the /introsio-pause procedure: pauseTask each task you hold with a note, nextSteps, the subtask you were on and the git position, so the work resumes exactly.
6. Parallel workers: give each agent its OWN folder (`int worktree add <name>` makes one) — two agents in one working tree share one branch and one set of files and break each other's work. Each uses its own workerId; the server never hands one task to two workers.
