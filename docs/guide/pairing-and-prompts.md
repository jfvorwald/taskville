# Pairing and answering prompts

## Pairing your browser

`taskville start` prints a one-time pairing link and opens it in your browser. The link is valid for a few minutes (the engine prints how many). Opening it pairs that browser; the pairing survives reloads and engine restarts.

- To pair another browser, press `p` in the engine's terminal for a new link, or restart `taskville start`.
- To revoke every paired browser, run `taskville unpair`. Pair again afterwards with a new link.
- The link is not written to the log, and the browser is not handed the link on its command line. `start` writes a short redirect page in the home folder and deletes it after about 30 seconds.
- With `--no-open`, the link is printed and nothing is opened. Paste it into the browser yourself.

## Reading the city

- Each agent is a block person. When it needs you, it stops, pulses red, and shows a speech bubble. Attention is also shown by shape, not only colour.
- The header counts active agents and agents that need you, across all projects.
- The accessible agent list mirrors the city for keyboard and screen-reader use.
- If the city is empty, the agent list tells you what to run: `taskville demo` to see agents, or `taskville init` in your repository to watch Claude Code.

## Answering a prompt

When Claude Code asks permission for a tool call, Taskville shows the agent as needing you. Click the agent to open the action card. It shows who is asking, the exact command or input, and the working directory.

- **Allow once** lets that one request through.
- **Deny** refuses it. You can add a note the agent will read.
- **Open session** copies the session and working directory so you can go to the terminal.

Taskville has no "always allow" and no bulk approval. Each request is answered on its own.

Some things to know:

- Taskville holds the request for up to 90 seconds by default. If no answer comes, Claude Code shows its normal prompt in the terminal, and you can answer there.
- The terminal prompt stays available while Taskville holds the request. Whichever you answer first wins; the card then says the prompt was answered and disables its buttons.
- If the engine is down or no browser is paired, nothing is held. Claude Code behaves as if Taskville were not installed.
- If an agent shows as needing you but the card offers only **Open session**, Taskville saw the prompt in telemetry but cannot answer it. Answer it in the terminal. The usual cause is a Claude Code launched without `TASKVILLE_BRIDGE_TOKEN` (see [install](install.md#let-the-browser-answer-prompts)).
- Prompts that arrive while the engine was down are shown from the spool as past events. They never open a new prompt, because the moment has passed.
