# Privacy

What reaches the public site, and what the plugin does to keep your slip off it.

## Privacy zones

A position inside a zone is published as the zone's **center**, and that point
is left out of the GPX track **entirely** rather than snapped to the middle —
a night at the dock would otherwise be a pile of identical points saying
exactly where you sleep. Speed and course are withheld from the track too, so
it cannot show you maneuvering in the harbor.

**Every** position in the published snapshot is checked, not just
`navigation.position`. That matters most for `navigation.anchor.position`:
checking only the boat would show the zone center for the boat while
publishing the true anchor drop coordinates a few keys away in the same file.
Anything position-shaped anywhere in the tree is covered, including paths a
plugin added that this one has never heard of.

The check is per position rather than per boat. An anchor position left over
from the slip you left this morning is still redacted while you are out
sailing. A destination in `navigation.course.nextPoint` is *not* redacted
because you happen to be at home — where you are going is not where you are.

Every check walks the whole zone list. Zones start empty: nothing is hidden
until you say what to hide.

**A corrected zone applies to what is already published.** The zones are
applied as a track is recorded, which on its own protects only the future: a
zone drawn in the wrong place, or too small to reach the slip, leaves every
day recorded under it on the site, and a past day's GPX file is never
rebuilt. So whenever the zones change — and on the first cycle after an
upgrade — the plugin reads every GPX file in the repository and takes out
each point inside a zone. A day that was nothing but the dock is deleted, and
the track index is rewritten to match; the log line says how many points,
files and days it took. The rolling 24-hour position index is re-checked on
every cycle, so this morning's fixes are covered by this afternoon's zone.
Trimming changes what the site serves. The old points are still in the
repository's git history; removing them from there means rewriting that
history, which the plugin never does.

The zone center is published as the boat's position while it is inside, so
put the center somewhere that is not your slip — the middle of the fairway,
or the harbor entrance — and make the radius reach past the slip with room to
spare. GPS wanders a few meters at the dock; a zone whose edge is 20 m from
the slip will let a night's worth of wander through.

The map draws the zones it is redacting against, as red dashed rings, on the
main map and on each voyage's map.

> [!NOTE]
> A zone missing its radius is a hard configuration error, not a warning. A
> half-entered zone hides nothing while looking like it does, and the failure
> mode is a published position someone believed was redacted.

## The logbook

Logbook entries from signalk-logbook carry the boat's position and the active
waypoint's. Neither is published: each entry is rebuilt from a fixed list of
fields that includes no position, and only days on the voyage list are
published, so notes written at the dock stay on the boat. See
[The logbook](site.md#the-logbook).
