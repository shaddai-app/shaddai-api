# Convenciones

## Ramas (trunk-based)

- `main` siempre desplegable y protegida: solo entra por Pull Request con CI verde.
- Ramas cortas desde `main`:
  - `feat/<modulo>-<descripcion>` — funcionalidad nueva (`feat/cells-weekly-report`)
  - `fix/<modulo>-<descripcion>` — corrección
  - `chore/…`, `docs/…`, `refactor/…`, `test/…`
- Merge con **squash**; borrar la rama después.
- Releases con tags semver `vX.Y.Z`.

## Commits (Conventional Commits, en inglés)

```
<type>(<scope>): <descripción en imperativo>

feat(auth): add refresh token rotation with reuse detection
fix(finance): prevent edits on closed periods
chore(deps): bump prisma to 7.10.1
```

Tipos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Scope = módulo (`auth`, `platform`, `people`, `cells`, `finance`, `db`, …). `commitlint` + `husky` lo validan.

## Pull Requests

- Descripción: qué, por qué y cómo se probó.
- Cada endpoint nuevo: permiso declarado, schema zod, test de permisos y **test de aislamiento multi-tenant**.
- Cambios de schema: una migración por PR, revisar el SQL generado (índices filtrados y `NoAction`).
- Nada de secretos en el código ni en commits.
