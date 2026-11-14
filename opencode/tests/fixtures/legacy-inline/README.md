# Legacy inline agent fixtures

Captured from the pre-story installer at baseline `cf7e77e` for story 1.2
to migrate. Each file holds the inline `agents.<id>` values the installer
wrote, the ownership records that point at them, and a manifest skeleton with
the agent records. The fixture is agent-focused: skill and instruction records
are intentionally not copied because the migration only changes agent storage.
The ARS checkout path is stored as `<package-root>` so the fixture does not
depend on one machine. The captured manifest digests are intentionally not
stored, because they were computed from the capture machine's absolute path:
after expanding `<package-root>`, recompute each digest with
`digestValue(configAgents[id])` and write it to both the manifest record and
the skeleton. `digestRule` repeats this in each file.

Regenerate only by checking out the pre-markdown installer and re-running the
same four variants; the point of these files is that they are NOT produced by
the Markdown writer.

| file | channel/scope | agents |
|------|---------------|--------|
| `install-plugin-project.json` | plugin/project | `research-architect-agent`, `synthesis-agent`, `report-compiler-agent`, `screening-reviewer-agent` |
| `install-plugin-global.json` | plugin/global | `research-architect-agent`, `synthesis-agent`, `report-compiler-agent`, `screening-reviewer-agent` |
| `install-skills-project.json` | skills/project | `screening-reviewer-agent` |
| `install-skills-global.json` | skills/global | `screening-reviewer-agent` |
