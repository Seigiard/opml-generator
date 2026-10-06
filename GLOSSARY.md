# Audiobook Publishing

Locally stored audio is published as podcasts for listening in podcast apps.

## Language

**Library**:
The collection of source audio files and folders from which podcasts are published.
Its current contents, names, and embedded audio metadata define the published collection.

**Audio file**:
A source file recognized as audio by its extension: `.mp3`, `.m4a`, `.m4b`, or `.ogg`.
Successful metadata reading and verified playability are not prerequisites for inclusion in the catalog.

**Catalog**:
The published view of the library's audio and folder hierarchy.
It includes only folders with at least one supported audio file directly inside them or in their descendants.
_Avoid_: Library (when referring only to the published view)

**Audiobook**:
An audio recording of a literary work, which may span one or more episodes.
An audiobook is distinct from the podcast through which it is published.

**Podcast**:
A subscribable collection of episodes from audio files directly inside one source folder.
Audio files in child folders belong to separate podcasts, even when they are part of the same audiobook.
_Avoid_: Audiobook (when referring to a subscription)

**Podcast author**:
A podcast's attribution label, given by the name of the parent of its source folder.
The label may name a writer, narrator, or another grouping; it does not establish a person's role.
_Avoid_: Audiobook author (when referring to this label)

**Episode**:
A listening unit in a podcast corresponding to one audio file, which may contain part or all of an audiobook.
Renaming the source audio file creates a new episode.
_Avoid_: Chapter (when referring to an episode)

**Episode number**:
An episode's current position in its podcast's listening order, starting at one.
The number can change when the collection or its order changes and is distinct from the episode's identity.
_Avoid_: Episode ID

**Episode date**:
The date supplied by a podcast for an episode's display in a podcast app.
It may be synthetic.
