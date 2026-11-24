[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/durov001/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/durov001/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend is one patch tool for every AI edit format: it reads a patch in unified diff, SEARCH/REPLACE, V4A, or JSON form (auto-detected, or forced with `--format`), applies its edits to the files in the working directory, and reports what changed. Matching is tiered — exact first, then trailing-whitespace-insensitive, then leading-and-trailing-whitespace-insensitive — with `--strict` pinning it to exact matches only, and context lines are always written from the file's own matched lines so indentation survives. Paths are safety-checked before anything else, every edit is applied atomically (one failure means nothing is written), and `--check` previews the result without writing anything.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--check` (dry run), `--strict` (exact matching only), `--format=<auto|unified|search-replace|v4a|json>`. `PATCH` is a patch file, or `-` / omitted to read from standard input.

<sub>Entered on [make.fun](https://make.fun/?ref=zsk0hsg3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
