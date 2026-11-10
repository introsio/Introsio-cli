Resume paused or interrupted Introsio work exactly where it stopped, with the Introsio MCP tools — but only after checking that the repository still matches the pause.

What to resume: $ARGUMENTS (a task id, a project name or id, or empty).

1. Find the work:
   - a task id → that task;
   - a project → getProjectState { projectId }: ids.pausedTasks lists its paused tasks;
   - empty → getProjects, then getProjectState for each Developer Mode project until you find paused tasks. (In a terminal, `int paused` lists the pauses made on this computer.)
   Also count a task as interrupted if it is in progress with a claim whose worker is gone (the Introsio hook says so when it sees one). Several candidates → list them (title, paused when, by whom, where) and ask the user which. None → say so and stop.
2. Read it WITHOUT claiming it: getTaskById { taskId }. Its `pause` holds the note, nextSteps, the subtask and the git position. The Introsio hook answers with a resume check — EXACT, DRIFT or BLOCKED and the precise differences. If no check appears (your agent runs no hooks), check by hand:
   a. same repository, no merge/rebase in progress (git status);
   b. on pause.git.branch (git rev-parse --abbrev-ref HEAD) — else `git switch <branch>`;
   c. HEAD is pause.git.head (git rev-parse HEAD); if not: `git log <head>..HEAD` (someone added commits), or HEAD is behind / the history was rewritten;
   d. the files in pause.git.dirtyFiles still have their unfinished changes (git status, git diff);
   e. the paused subtask is still open, and the task was not edited since (its updatedAt after pause.at).
3. Act on the verdict:
   - EXACT → step 4.
   - DRIFT → show the user each difference in plain words and ask how to go on: restore the snapshot (run the exact restore command the check gave, only after they agree), continue from the repository as it is, or leave it paused. Leaving it paused changes nothing.
   - BLOCKED → do not resume. Explain what is wrong (e.g. the unfinished code is on another computer, another session is working it, a rebase is half done) and stop.
4. Take it back: claimTask { taskId, workerId, resume: true } — use your own workerId. For a task interrupted WITHOUT a pause, the hook names the dead session's workerId: claim with that one to take it over at once. If the claim is refused because someone else resumed it first, stop and tell the user.
   The answer carries resumedPause and taskChangedSincePause: if the task changed, read its spec again before coding. If the context revision moved since the pause (pause.contextRevision), getProjectContext once.
5. Continue from the note and nextSteps, starting at the paused subtask (one updateSubtask { completed: true } when it is done). From here it is the normal loop: work → check → commit → completeTask { taskId, workerId, outcome } → claimTask { projectId, workerId } for the next task, as /introsio-execute does. If you must stop again, use /introsio-pause.
