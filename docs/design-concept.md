# Opplinotes – Designkonzept „Stilles Papier“

Stand: November 2026. Grundlage für das komplette visuelle Redesign (Bibliothek, Editor, Dialoge, Dark Mode).

## 1. Ausgangslage – was am alten Design störte

- **Zu viele gleichwertige Knöpfe.** Die Kopfzeile der Bibliothek hatte fünf umrandete Buttons nebeneinander (From Goodnotes, Import, New notebook, Sync, …). Nichts führte das Auge.
- **Linien statt Flächen.** Fast jedes Element hatte einen Rahmen. Dazu kamen Trennlinien unter Kopfzeile, Titel und Sortierung. Das wirkte unruhig und „formularhaft“.
- **Uneinheitliche Bausteine.** Für dieselbe Aufgabe gab es drei Bauformen: Ansichtswahl als Dropdown, Markieren/Unterstreichen als blaue Segmentleiste, Werkzeuge als graue Kapsel. Die Radien lagen zwischen 2 und 16 px.
- **Kühles Blaugrau mit grellem Indigo.** Neutraltöne und Akzent harmonierten nicht. Im Dark Mode wurden viele Einzelfarben per Hand überschrieben.
- **Editor-Leisten ohne Gliederung.** Rund 20 Icons standen in einer Reihe, nur durch Abstände getrennt. Die Optionsleiste hatte einen eigenen, leicht anderen Grauton.

## 2. Recherche – was moderne Apps 2025/26 vormachen

| Quelle | Erkenntnis | Übernahme für Opplinotes |
| --- | --- | --- |
| Apple „Liquid Glass“ (iOS/iPadOS 26) | Toolbars als abgerundete Kapseln, die zusammengehörige Bedienelemente **gruppieren**. Symbole statt Textlabels, Pillen- und Kreisformen. | Editor-Leiste in Kapsel-Gruppen; Pillen-Buttons; leicht transluzente Leiste mit Hintergrundunschärfe. |
| Goodnotes-Toolbar-Umbau (Sept. 2025) und Nutzerfeedback | Viele Nutzer beklagen, dass eine **schwebende Leiste die Seite verdeckt** und Klicks kostet. | Die Leiste bleibt **angedockt** (oben oder links) und verdeckt nie Papier. Nur der modernen Optik wegen wird sie nicht schwebend. |
| Linear-Refresh (2025) | „Don’t compete for attention you haven’t earned“; „Structure should be felt, not seen“. Wärmeres Grau, weichere Rahmen, weniger Trennlinien, weniger und kleinere Icons. | Wärmeres Neutralgrau, fast keine Trennlinien, Flächen statt Rahmen, nur noch eine Primäraktion pro Ansicht. |
| Linear/LCH-Farbsystem, Radix Colors | Farben im wahrnehmungsgleichmäßigen Farbraum; 12-stufige Skalen mit festen Rollen (1–2 Hintergrund, 3–5 Komponenten, 6–8 Rahmen, 9–10 Vollton, 11–12 Text). Gleiche Stufe = gleiche Rolle in Hell **und** Dunkel. | Alle Farben als **OKLCH-Tokens** in zwei 12er-Skalen (Neutral + Tinte). Dark Mode tauscht nur die Skala, nicht einzelne Komponenten. |
| Material 3 Expressive | Pillenförmige Toolbars, Form und Bewegung als Hierarchiemittel, federnde, räumlich zusammenhängende Animationen. | Kurze, weiche Ein-/Ausblendungen für Popover, Dialoge und Toasts; „reduced motion“ wird respektiert. |
| Inter / System-UI-Schriften | Tabellenziffern (`tnum`) für Zähler; Display-Schnitt für große Titel. | Systemschrift (Inter, falls installiert); Tabellenziffern für Seitenzahlen, Zoom und Anzahlen; enges Tracking bei großen Titeln. |

## 3. Leitidee: „Stilles Papier, Werkzeug griffbereit“

Das Papier ist das einzige laute Element. Alles andere tritt zurück, bis man es braucht.

1. **Inhalt zuerst.** Die Oberfläche nutzt Grau-Abstufungen statt Farbe; Farbe bekommen nur Auswahl, Fokus und die Hauptaktion.
2. **Struktur fühlen, nicht sehen.** Flächen und Tonwerte statt Linien; Rahmen nur als feine Haarlinie, wo sie wirklich trennen.
3. **Gruppieren statt aufreihen.** Bedienelemente leben in Kapseln mit klarer Aufgabe (Verlauf · Werkzeuge · Einfügen · Ansicht · Dokument).
4. **Ein Baukasten.** Für jede Aufgabe gibt es genau eine Bauform: ein Segment-Control, ein Button-System, eine Menüform, eine Dialogform.
5. **Hell und Dunkel gleichwertig.** Komponenten kennen nur Rollen-Tokens. Der Dark Mode ist eine zweite Werteskala.
6. **Stift-tauglich.** Trefferflächen sind mindestens 36 px groß, im Editor 38–40 px. Auf Touch-Geräten gibt es keine Hover-Abhängigkeit.

## 4. Tokens

### Farbe (OKLCH, 12 Stufen)

| Rolle | Neutral hell | Neutral dunkel | Verwendung |
| --- | --- | --- | --- |
| 1 | 98.8 % | 16.5 % | App-Hintergrund |
| 2 | 97.4 % | 19 % | dezente Fläche, Leisten |
| 3 | 95.2 % | 22 % | Komponenten-Hintergrund (Segment-Spur, Felder) |
| 4 | 93.2 % | 24.5 % | Hover |
| 5 | 91 % | 27 % | gedrückt / aktiv |
| 6 | 89 % | 29.5 % | Haarlinie |
| 7 | 85 % | 33.5 % | Rahmen |
| 8 | 77 % | 41 % | starker Rahmen, Scrollbar |
| 11 | 50 % | 72 % | Sekundärtext |
| 12 | 21 % | 95 % | Text |

Das Neutralgrau ist ganz leicht warm (Farbton 85°, Chroma ≤ 0.007).
Der **Akzent „Tinte“** ist ein tiefes Blauviolett (Farbton 268°): Vollton `oklch(53% .2 268)`, Text `oklch(47% .2 268)`, Fläche `oklch(95.5% .025 268)`. Er ersetzt das grelle Indigo.
Dazu kommen die Semantikfarben Gefahr (25°), Erfolg (150°) und Hinweis (75°), jeweils als Vollton und Fläche.

Der **Schreibtisch** (Hintergrund hinter den Seiten) ist eine eigene Fläche: hell `oklch(92.5% .005 85)`, dunkel `oklch(12.5% .004 85)`.

### Form

- **Radien konzentrisch:** 6 (Mini) · 10 (Felder, Menüzeilen) · 14 (Karten, Popover) · 20 (Dialoge, Panels) · `999px` (Buttons, Segmente, Kapseln). Innenradius = Außenradius − Innenabstand.
- **Höhen:** 30 (klein) · 36 (Standard) · 40 (Editor-Werkzeuge, Felder in Dialogen).
- **Abstände:** 4-px-Raster (4, 8, 12, 16, 20, 24, 32, 48).

### Tiefe

Drei Ebenen. Jede kombiniert einen feinen Haarlinien-Ring mit einem weichen Schatten statt eines Rahmens:
`--e1` Karten, `--e2` Hover/aktive Segmente, `--e3` Popover, Dialoge und Toasts.

### Typografie

Systemschrift (SF Pro → Inter → Segoe UI Variable → Noto Sans).
Größen: 11.5 Label · 12.5 Meta · 13.5 UI · 15 Kartentitel · 18 Dialogtitel · 30 Seitentitel.
Gewichte: 400/500/600/700. Titel ab 18 px bekommen negatives Tracking (−0.01 bis −0.03 em). Zahlen nutzen `tabular-nums`.

### Bewegung

120 ms für Hover/Farbe; 160–200 ms für Popover, Dialoge und Toasts (Deckkraft + Skalierung 0.97 → 1, `cubic-bezier(.2,.8,.2,1)`); Karten heben sich beim Hover um 2 px. `prefers-reduced-motion` schaltet alles ab.

## 5. Komponenten

- **Button:** Pille. Varianten: *primary* (Akzent-Vollton), *secondary* (Fläche 3, kein Rahmen), *ghost* (transparent, Hover Fläche 4), *danger*.
- **Icon-Button:** Kreis, 36 px; im Editor 38 px. Aktiv: weiße „Thumb“-Fläche mit Schatten und Akzent-Icon.
- **Segment-Control:** eine Spur (Fläche 3, Pille) mit einem hellen, schwebenden Thumb. Dieselbe Bauform gilt für Werkzeuge, Bibliotheksansicht, Markieren/Unterstreichen, Radiermodus, Erscheinungsbild und Toolbar-Position.
- **Feld/Suche:** Fläche 2 mit Haarlinien-Ring. Fokus: Akzentrand und weicher 3-px-Halo.
- **Menü/Popover:** Radius 14, Ebene 3, Zeilen mit Radius 8, Icons in Sekundärfarbe, kurze Einblende-Animation.
- **Dialog:** Radius 20, Titel 18/650, Aktionen rechts. Abgedunkelter Hintergrund mit leichtem Blur.
- **Toast:** dunkle Pille unten mittig, gleitet herein.

## 6. Ansichten

### Bibliothek

- **Kopfzeile:** Marke · Suche (Pille, mittig) · Sync-Status als ruhiger Chip · **Import ▾** (ein Menü statt zwei Buttons: PDFs/ZIP/Backup, Ordner, Goodnotes) · **New notebook** (einzige Primäraktion) · Mehr-Menü.
- **Titelbereich:** Brotkrumen klein darüber, großer Titel. Rechts ein Segment-Control *Documents · All · Favourites* (statt Dropdown) und „New folder“ als Ghost-Button.
- **Sortierung:** eine leise Zeile ohne Trennlinie.
- **Ordner:** flache Kacheln mit einem getönten Ordnersymbol. Die vier Tönungen haben gleiche Helligkeit und gleiches Chroma, damit keine Farbe heraussticht.
- **Notizbücher:** Das Cover ist das Objekt (Papier mit Rücken, weicher Schatten, Hover-Lift); der Titel steht darunter.
- **Leerer Zustand:** Symbol im Kreis, Titel, Satz und Primärbutton.

### Editor

- **Leiste angedockt, aber leicht:** transluzente Fläche mit Blur und nur einer Haarlinie zum Schreibtisch.
- **Kapsel-Gruppen:** ← · Titel · [Undo Redo] · **[Werkzeuge]** (zentrales Segment) · [Bild Lineal] · … · Seite 1/4 · Zoom · [Finger Rand Einstellungen] · [Export Seiten +].
- **Optionsleiste:** gleiche Fläche wie die Leiste, die Gruppen trennen feine senkrechte Linien. Farben sind 22-px-Punkte mit Akzentring; Stärken sitzen in einem Mini-Segment. Hinweise rücken nach rechts, gedämpft.
- **Schreibtisch:** warmes Hellgrau (Dunkel: fast Schwarz). Seiten bekommen einen realistischen, zweistufigen Schatten.
- **Seitenleiste:** Fläche 2; die aktuelle Seite hat einen Akzentring und eine Nummernpille.
- **LaTeX-Panel:** schwebendes Sheet mit Radius 20, Ebene 3.
- **Linke Leiste:** Die Kapseln stapeln sich senkrecht. Bauformen und Tokens bleiben gleich.

## 7. Nicht-Ziele

- Keine schwebende Werkzeugleiste über dem Papier (siehe Nutzerfeedback zu Goodnotes).
- Keine Web-Schrift-Downloads: Die App bleibt offline-fähig und klein.
- Funktionen und Tastenkürzel bleiben unverändert. Es ändert sich nur die Darstellung, plus die Zusammenlegung der Import-Buttons und die Ansichtswahl als Segment-Control.
