# System Shock 2 Build Planner

A single-page build planner for *System Shock 2: 25th Anniversary Remaster*, written in plain HTML5, CSS3 and JavaScript. It uses the game's own upgrade-unit art.

## Using it

- On the first visit (or after a reset) the **Ramsey Recruitment Center** opens. Pick a branch (Marines, Navy, OSA) and one posting for each of the three years. Those bonuses are free, and an amber pip marks them on the upgrade units. The career button in the top bar changes your path later and keeps the upgrades you bought.
- The **O/S Upgrades** unit holds all 16 upgrades. You can install 4, one per O/S station (MedSci, Hydroponics, Recreation, Rickenbacker), in that order. Each station's diamond on the module bar lights up once it's used. **Naturally Able** raises the module cap by 20 from the level where you installed it, and **Tank** adds 10 max HP (both Remaster values).
- **Left-click** an upgrade to buy the next level, **right-click** to refund one level. On a touch screen, **tap** to buy and **press and hold** to refund.
- **RESET**, the vertical button on each unit's right edge, refunds everything bought at that unit. Career bonuses stay.
- **Reset build** (top right) clears the whole build, career included, and reopens career selection. Click it twice to confirm.
- The sticky module bar also shows your **maximum HP and psi points**, using the game's HUD bars. Max HP is the difficulty's base plus a per-point amount times END. Max psi is the base plus a per-point amount times PSI, plus +2/+4/+6/+8/+10 for each Neural Capacity tier you own. The fill shows how close you are to the best possible value on that difficulty, and hovering or tapping a bar shows the formula. On phones the level tags show only their module counts; tap one for the level's name.
- The difficulty buttons switch the cost tables (Easy ×0.85, Hard ×1.4, Impossible ×1.8, rounded down).
- The **Implants** panel next to the O/S Upgrades unit lists every implant. Click one to **equip** it: one slot, or two with the Cybernetically Enhanced O/S upgrade. When every slot is taken, you have to remove an equipped implant before equipping another. The **Active effects** readout below lists what the equipped implants do. While equipped, a stat implant's bonus counts toward other items' requirements and the HP/psi bars (EndurBoost, PsiBoost), but not toward upgrade costs. ExperTech's bonus never counts toward requirements. An equipped implant is removed if the build stops meeting its requirements, for example when you refund the Research it needs.
- Hover an inventory item to see its requirements. Items whose requirements aren't met are greyed out, and the skills they need light up in the upgrade units.
- The build is saved in the browser and in the URL hash, so you can share it by copying the link. Opening someone else's link doesn't overwrite your own saved build: a notice lets you **keep** the linked build or **restore** yours.

## Data (`data/*.json`)

| File | Contents |
|---|---|
| `costs.json` | Module cost tables for each difficulty, and the 882 module cap (the Remaster's total) |
| `disciplines.json` | Attributes, weapon skills and tech skills (min/max values, help text) |
| `psi.json` | The 5 psi tiers: Neural Capacity plus 7 disciplines each, with icons and help text |
| `items.json` | Weapons, armor and implants: icon, size in inventory cells, requirements, description |
| `careers.json` | Service branches, basic training and the three yearly postings, with their free bonuses |
| `os-upgrades.json` | The 16 O/S upgrades (icon, Remaster description, effects) and the 4 O/S stations |
| `decks.json` | Cyber Modules obtainable on each level, which places the markers on the module bar |

Costs, requirements and icon assignments come from the game's `shock2.gam` and string files, including the Remaster's implant colour fix. The module counts per level come from the System Shock Wiki.

The fonts in `assets/fonts` are Michroma and Rajdhani (Latin subset), both under the SIL Open Font License.
