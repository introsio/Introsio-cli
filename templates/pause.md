Pause the Introsio work in this session so it can be resumed EXACTLY later — by you in a new session, or by another agent — with the Introsio MCP tools. Use this when you are running out of usage, context or time, or the user asks you to stop.

What the user added: $ARGUMENTS (may be empty). "--release" means: hand the work to any worker (commit it first). Anything else is a note to pass on.

Be fast and do only this — no new work, no refactoring. If you are cut off part-way, what was already saved still counts.

1. Find what you hold: every task you claimed in this session and have not completed (the Introsio hook has also told you which). Hold none? Go to step 6.
2. For each task, settle its subtasks honestly: list the ids of the steps that are really finished and checked and that you have not reported yet — they go in completedSubtasks on the pauseTask call below, recorded with the pause (no call per step). The step you were in the middle of is NOT on that list: it stays open — remember its subtaskId for handoff.subtaskId.
3. Read the git position (skip outside a git repository):
   - git rev-parse --abbrev-ref HEAD   → branch
   - git rev-parse HEAD                → head
   - git status --porcelain            → dirtyFiles (the paths only)
   Never commit, stash, reset or clean anything for a plain pause: the unfinished files stay exactly where they are.
4. Only with --release: commit the task's work on its own branch (create introsio/<taskId> first if you are on the default branch), push it if the project has a GitHub repository, and record it with updateTask { taskId, workerId, outcome: { branch } }. If you cannot commit cleanly, pause without release instead and say why.
5. For each task: pauseTask { taskId, workerId, agentName, release (only with --release), completedSubtasks: [the ids from step 2], handoff: {
     reason: "usage_limit" | "context" | "user" | "other",
     subtaskId: the subtask you were on,
     note: written for someone who has NONE of your conversation — what is finished, what is half done and exactly how far (function, file:line, the failing test), what you were about to do, anything you tried that did not work, and the user's note if they gave one,
     nextSteps: [ the next actions, in order ],
     host: this computer's name (hostname),
     git: { branch, head, dirtyFiles }
   } }
   If the Introsio hook refuses it with the exact git values to send, call pauseTask again with exactly those (they include the snapshot of your working tree).
6. If you hold no task: updateProjectState { projectId, handoff: true, execution: { description: where things stand, status: "paused" }, nextSteps } for the project you were working on.
7. Tell the user, in a few lines: what was paused, what is saved (the note, and that the working tree snapshot is kept locally and nothing was committed unless --release), and how to continue — `/introsio-resume <taskId>` in any agent connected to Introsio (`int paused` in a terminal lists every pause on this computer). Then stop.
