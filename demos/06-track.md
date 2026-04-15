# track

Add file patterns to sync

---

$ npx ziku track '.eslintrc.json' 'tsconfig.json'

> [bold][cyan]┌   ziku track  v1.2.0[/cyan][/bold]
> [gray]│[/gray]
> [gray]│[/gray]  [green]+[/green] Added pattern: [cyan].eslintrc.json[/cyan]
> [gray]│[/gray]  [green]+[/green] Added pattern: [cyan]tsconfig.json[/cyan]
> [gray]│[/gray]
> [green]└[/green]  2 patterns added to .ziku/ziku.jsonc

[wait:1500]

$ npx ziku track --list

> [bold][cyan]┌   ziku track  v1.2.0[/cyan][/bold]
> [gray]│[/gray]
> [gray]│[/gray]  Tracked patterns:
> [gray]│[/gray]  [cyan].claude/settings.json[/cyan]
> [gray]│[/gray]  [cyan].claude/rules/*.md[/cyan]
> [gray]│[/gray]  [cyan].devcontainer/**[/cyan]
> [gray]│[/gray]  [cyan].github/**[/cyan]
> [gray]│[/gray]  [cyan].eslintrc.json[/cyan]
> [gray]│[/gray]  [cyan]tsconfig.json[/cyan]
> [gray]│[/gray]
> [green]└[/green]  6 patterns tracked
