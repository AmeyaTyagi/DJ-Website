# Blend Room

A four-deck DJ station that runs entirely in the browser. Feed it tracks, it reads their
tempo, key and energy, builds a set in the style you pick, and mixes it itself — while you
keep your hands on the board.

No build step, no dependencies, no `npm install`. Just Node and a browser.

## Run it

| How | What to do |
| --- | --- |
| **F5** | Runs the server and opens Edge on it, with the debugger attached. |
| **Ctrl+Shift+B** | Starts the server in a terminal panel; Ctrl+click the link it prints. |
| Terminal | `npm start` — server plus your default browser. |

Stop it with **Ctrl+C**. Any file you save reloads the open tab.

```bash
node server.js              # http://localhost:5173
node server.js --open       # ...and open the browser
node server.js --no-reload  # serve the files exactly as they are on disk
PORT=8080 node server.js    # different port
```

## The five tabs

**Board** — the home screen, laid out like a DDJ-FLX10. Two jog wheels, each switchable
between its two decks (left drives A or C, right drives B or D), eight performance pads per
side across four modes, four channel strips with trim / 3-band EQ / filter / fader /
crossfader-assign, and a crossfader. Drag a jog to bend the pitch; right-click a hot-cue pad
to clear it.

**AI Set** — pick a style profile, see the running order it produced, the energy arc against
the profile's target, and every transition with the reason it was chosen. Rate joins as they
play; skip tracks you don't want.

**Model** — import recorded mixes, train on your own moves, and read the honest numbers.

**Crate** — your library, dropped files, synthesised stand-ins, and the network sources.

**Lab** — eight drum voices, a scale locked to the set key, a 16-step sequencer, master FX.

## Where the music comes from

Four routes, and one that does not exist:

1. **Drop files in** — any format the browser decodes. Never uploaded.
2. **Import your library** — give it a folder and the server walks the tree, then imports
   the files you tick. Reads straight off disk; nothing is copied.
3. **Any direct audio URL** — your own server, a NAS, an Internet Archive item. Fetched by
   your server, so cross-origin rules don't apply. Private and loopback addresses are
   refused, and every URL is logged in the terminal.
4. **Internet Archive search** — open, legal and large. Live recordings, netlabel
   electronic, CC releases. Not the commercial Top 40.
5. **Commercial streaming catalogues — not possible.** Spotify and Apple serve 30-second
   previews behind DRM and forbid audio manipulation; there is no legitimate API that hands
   a web app a full commercial release. Bring your own files for those.

## Style profiles

Six rule sets, each a different answer to "how long is a join, when does the bass change
hands, how strict are the keys, what shape does the night take":

| Profile | Reference point | What it does |
| --- | --- | --- |
| Peak-time tech house | a John Summit set | 32-bar EQ blends, bass handed over late, loop roll into the drop, energy held at the top |
| Rave house | a KETTAMA set | 134 BPM, 16–24 bar joins, sub swapped early, keys treated loosely |
| Festival electro | a Zedd set | 32-bar builds, riser over the last bars, hard cut on the downbeat, deliberate dips before peaks |
| Melodic progressive | a Lane 8 set | 48-bar filter-led blends, harmonic only, patient climb, nothing cut |
| Rolling techno | a Charlotte de Witte set | 16-bar joins, early bass swap, echo cuts on clashes |
| Open-format house | a Honey Dijon set | wide tempo tolerance, quick joins, a rollercoaster arc |

**These are rules, not models of those artists.** Nobody's audio, stems or session data went
into them. They encode mixing habits those sets are widely known for, and you can hear the
difference between them because the numbers differ, not because anything was cloned.

A seventh profile, **Learned from your mixes**, appears once you have imported enough
recorded sets for the measurements to mean something.

## What actually learns

Two mechanisms, kept apart because they learn different things from different data.

### Reading recorded mixes — experimental

Drop a recorded DJ set into the Model tab. It decimates to 8 kHz, splits into low / full /
high bands with one-pole filters at 100 ms resolution, finds the global tempo, and then looks
for the clearest tell a transition leaves in a finished mix: **the low band dropping out while
the track keeps rolling**, which is a DJ swapping the bass across. For each one it records the
length in bars, how deep the dip went, and how much the top end changed, and classifies it as
a blend, EQ blend, filter sweep or cut.

That teaches it **how** to mix — join lengths and which kind to use. It cannot tell which
records were playing, so it learns nothing about running order from audio.

Be clear-eyed about this part: it will miss subtle blends and will sometimes call a breakdown
a transition. The UI labels it experimental for that reason.

### Your own moves

Every transition that runs, every skip, every rating becomes a labelled example. A ridge
regression over eight track-pair features — tempo gap, Camelot distance, energy lift, how hard
the next track hits, distance from the arc target, whether you hearted it, how far into the
set, plus a bias — is fitted by gradient descent, with a quarter of the data held back.

The Model tab reports **holdout error, improvement over predicting the average, and sign
agreement**, and shows every learned weight. If it isn't beating a plain average it says so
and tells you to stick with the rules. Below 25 examples it says it's guessing, because it is.

Turn on *Let the model influence track order* and set how much say it gets. Save the weights
and examples to `dj-model.json` next to `index.html`.

## Files

```
index.html      the whole app — markup, styles, audio, analysis, model
server.js       dev server: static files, live reload, audio proxy,
                Internet Archive search, library scan, model storage
package.json    scripts only; no dependencies
dj-model.json   written when you save the model (not in the repo until then)
.vscode/        launch (F5), tasks (Ctrl+Shift+B), extension suggestions
```

Banner comments mark the sections in `index.html`: `analysis`, `synth voices`,
`track synthesis`, `deck`, `four decks`, `mix planning`, `the set engine`,
`training data`, `the model`, `sound lab`.

## How the mixing works

**Analysis.** Tempo from an onset-flux envelope through a comb filter across 68–190 BPM, with
half and double-time partners weighted in; the winning lag gives the beat phase. Key from a
12-bin Goertzel chroma correlated against the Krumhansl profiles, which also yields the
Camelot code. Energy blends loudness and spectral brightness. Every track also gets a trim
that lands it near a common loudness, so a quiet one doesn't drop the floor out.

**Ordering.** Each slot has a target energy read off the profile's arc; the track chosen for
it is the one that hits that target while still mixing out of the track before it, scored on
tempo gap, Camelot distance and energy movement. With the model on, its prediction pulls that
choice around.

**Playing.** Transitions start on a bar line of the outgoing deck — the incoming source is
scheduled on the audio clock rather than started whenever a timer fired, which is what keeps
two tracks phase-locked. Segments are counted in 8-bar phrases. The bass is never doubled: the
incoming low is cut until the swap point the profile sets. The crossfader, EQs and filters you
see moving are the real ones.

## Notes

- Your files never leave the machine.
- Browsers won't start audio until you click something; the first click resumes the audio
  context. Platform rule, not a bug.
- DRM-protected files can't be decoded by any browser.
- Tempo and key figures are estimates, as on any DJ controller.
- Imports are capped at 45 MB per file — `decodeAudioData` expands to 32-bit float PCM, so a
  45 MB mp3 already lands near 700 MB in the tab.
- The two web fonts come from Google Fonts. Offline, the page falls back to system faces and
  everything else still works.
- The demo crate is synthesised at load from four-bar cells laid out over an arrangement.
  Scheduling all 24 bars in one offline render queued ~2,900 nodes and took about 30 seconds
  per track; cells bring the whole crate in around two.
