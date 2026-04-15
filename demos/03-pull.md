# pull

Pull the latest template updates with 3-way merge

---

$ npx ziku pull

> ┌   [bold][cyan]ziku pull[/cyan][/bold]  [gray]v1.2.0[/gray]
> │
> ●  Template: my-org/dev-templates

[spinner:1500] Analyzing changes...

> │
> │  ↓ .claude/settings.json
> │  [green]+[/green] .claude/rules/testing.md
> │  [green]+[/green] .github/workflows/lint.yml
> │  [green]+[/green] .github/workflows/security.yml
> │
> │  [cyan]↓1 updated[/cyan] | [green]+3 new[/green]
> │

[spinner:1200] Merging changes...

> │
> [green]◆[/green]  Updated 1 file(s)
> │
> [green]◆[/green]  Added 3 new file(s)
> │
> └  Pull complete
