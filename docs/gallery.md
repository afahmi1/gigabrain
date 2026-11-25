# Gallery

All images show the **synthetic demo fixture** (150 generated `DEMO …` notes; see `demo/fixture.ts`). They are not from a real vault.
They were rendered in headless Chrome on the GPU at 1600×1000, Quality: High, using the bundled original procedural assets
(`assets/brain.glb`, `assets/brain_sdf.bin`, `assets/morphologies.json`). To regenerate them:

```sh
npm run build && node test/capture-gallery.mjs   # writes docs/images/*.webp
```

## Whole brain with cerebellum

![A folded, purple-grey 3D brain seen from the left rear, with a ridged cerebellum and brainstem below it. Small glowing cyan, orange and violet neurons cover the cortex, and the notes list is on the right.](images/brain.webp)

*Brain view, left posterior three-quarter angle. Each glowing neuron is one note, coloured by folder. The cerebellum and brainstem are part of the same original procedural mesh.*

## Lightning along a real link

![A close view of the folded cortex with an orange branching lightning discharge running between two neurons and dozens of coloured note neurons around it.](images/lightning.webp)

*One link discharge, triggered on purpose and frozen at the return stroke (leader, then a bright main channel with forks). Link bolts follow real wikilinks between notes and stay inside the brain's distance field.*

## Selected note and its links

![The brain from the side with one note, "DEMO Orbit 023", highlighted. Its tooltip reads "Memories · 7 links", and thin violet links lead to labelled neighbour notes such as "DEMO Vector 149" and "DEMO Atlas 027".](images/linked-note.webp)

*Hovering or selecting a note keeps it and its real linked neighbours lit and labelled, and dims the rest. The tooltip shows the folder and the link count.*
