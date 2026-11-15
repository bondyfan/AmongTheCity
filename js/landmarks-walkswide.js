// ---- landmarks-walkswide.js: the crowd's ways through Prague Castle ----
// Pure data, no imports, like js/landmarks-walks.js, which appends these to
// its own lists (one line at its end). The castle's four passages
// (js/landmarks-hradpass.js) are in the tile only as their mouths: the
// footways stop on one face of a wing and start again on the other, so the
// crowd turned round at every one of them. Each link starts at the end of the
// footway on the courtyard side (its anchor), runs the passage's centre line
// and ends at the footway on the far side. The points are the passages'
// frames as the model builds them (tests/landmarks-walks.test.mjs walks each
// link against the castle's solids).

const way = (id, p) => ({ _id: 'lmw:' + id, t: 'footway', w: 1.8, d: 0, s: 'cobble', p });

export const WALKS_WIDE = [
  // the Matthias Gate, from the 2nd courtyard out to the 1st
  { anchor: [-97264.1, -6527.9], way: way('hrad-matyas', [[-97264.1, -6527.9], [-97278.3, -6520.2]]) },
  // east to the 3rd courtyard: both footways on each side end on the corners of a wide mouth
  { anchor: [-97216.0, -6539.7], way: way('hrad-treti', [[-97216.0, -6539.7], [-97217.0, -6542.4], [-97196.6, -6549.9], [-97197.7, -6552.5]]) },
  { anchor: [-97218.0, -6545.0], way: way('hrad-treti-2', [[-97218.0, -6545.0], [-97217.0, -6542.4], [-97196.6, -6549.9], [-97195.5, -6547.2]]) },
  // north, under the north wing to the Powder Bridge
  { anchor: [-97245.8, -6564.4], way: way('hrad-sever', [[-97245.8, -6564.4], [-97251.6, -6592.8]]) },
  // south-west, out to the Garden on the Bastion
  { anchor: [-97240.3, -6477.9], way: way('hrad-jih', [[-97240.3, -6477.9], [-97251.3, -6471.8]]) },
];
/** The box every anchor above lies in (and the first point of every footway that ends on one). */
export const WALK_BOXES_WIDE = [[-97340, -6620, -97060, -6420]];
