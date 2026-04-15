# track

Add new file patterns to sync

---

$ npx ziku track '.eslintrc.json' 'tsconfig.json'

> [bold][cyan] ziku track [/cyan][/bold] [gray]v1.2.0[/gray]

> [green]+[/green] Added pattern: [cyan].eslintrc.json[/cyan]
> [green]+[/green] Added pattern: [cyan]tsconfig.json[/cyan]

> [green]◆[/green] 2 patterns added to .ziku/ziku.jsonc

[wait:500]

$ npx ziku track --list

> [bold][cyan] ziku track [/cyan][/bold] [gray]v1.2.0[/gray]

> Tracked patterns:
> [cyan].claude/**[/cyan]
> [cyan].devcontainer/**[/cyan]
> [cyan].github/\*\*[/cyan]
> [cyan].eslintrc.json[/cyan]
> [cyan]tsconfig.json[/cyan]
