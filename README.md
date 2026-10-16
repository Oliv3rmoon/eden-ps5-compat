# Eden PS5 Compat Log

An unofficial, community-run log of how Nintendo Switch games run in [ProsperoEden](https://github.com/blackbearreloaded/ProsperoEden), the Eden emulator port for PS5, plus a crash report explainer.

**Live page:** https://oliv3rmoon.github.io/eden-ps5-compat/

## Post a result

Use the **[Game result form](https://github.com/Oliv3rmoon/eden-ps5-compat/issues/new?template=compat-report.yml)**, or press **Post a result** on the page (it fills the form in for you). Each open issue labelled `compat-report` shows up on the page within a minute or two.

## How the log decides a game's status

- Every game is a list of results: the starting status from the public ProsperoEden issue reports, plus every result players post here.
- The **newest ProsperoEden version** anyone tested decides. On that version, the status most results agree on wins; a tie goes to the most recent result.
- A game shows **▲ better** or **▼ worse** when its status changed from the version before.
- A version tag with a **dashed border** means the game hasn't been tested on the latest version yet. The **Tested on latest** switch hides those.
- **Settings that work** is the most common settings line among results that say it plays well or with glitches.

## Keeping the log up to date

- **Add or change a game:** edit [`data/games.json`](data/games.json) on GitHub, then commit. Each game has a `name`, an optional `titleId`, a `status` (`well`, `glitches`, `unplayable`, `wontstart`, `mods` or `closed`), the ProsperoEden `version` it was tested on, related upstream `issues`, and a `note`.
- **New app release:** change `latest` in `data/games.json`. Games not tested on it get the dashed tag.
- **Trust a result:** add the `verified` label to its issue. Verified results count double.
- **Remove spam or a wrong result:** close the issue. Only open issues are shown.

The page is a single `index.html` with no build step. GitHub Pages serves it from the `main` branch.

---

Not affiliated with or endorsed by the ProsperoEden project, BlackBearReloaded, the Eden project, Sony or Nintendo. Only play games you own, dumped from your own hardware. Never post game files, keys or firmware.
