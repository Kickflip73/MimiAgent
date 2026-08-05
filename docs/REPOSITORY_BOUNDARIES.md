# Repository asset boundaries

MimiAgent separates product source from work created with the product.

## Product-owned

The main repository owns runtime source, tests, architecture and protocol documentation, release examples, evaluations, and the product Skills listed with `"status": "product"` in `skills/manifest.json`. Only those Skills may be included in the npm package.

`knowledge/mimi-agent.md` is product documentation used by the retrieval evaluation and is published by exact path. It is not a user Memory store.

## External workspace-owned

User projects, generated sites, screenshots, browser captures, private research notes, and runtime knowledge belong outside the product repository:

- standalone projects use their own repositories;
- disposable generation output uses an ignored `playground/` or another external workspace;
- personal knowledge is ingested into the user's private MimiAgent data root, normally `~/.mimi-agent`, and is never published;
- runtime databases, credentials, device identities, traces, and computer artifacts are always private state.

The public repository does not include workspace projects, generated media, browser captures, private research notes, runtime evidence, or experimental Skills.

`npm run check:repo` validates that every checked-in Skill is classified, product Skills exactly match package publication, personal knowledge is not broadly included, and workspace project roots cannot enter the tarball.
