// Gallery shots — filenames match Shot ID convention used in Immich.
// Drop real photos into public/images/ with these exact filenames to replace placeholders.

export type Shot = {
  id: string;
  filename: string;
  alt: string;
  caption: string;
  aspect: 'landscape' | 'portrait' | 'square';
  category: 'exterior' | 'interior' | 'area' | 'kitchen' | 'bedroom';
};

export const shots: Shot[] = [
  // Exterior
  {
    id: 'PRO-01',
    filename: 'PRO-01.jpg',
    alt: 'Front of Little Slate House, a Victorian stone cottage in Keswick town centre',
    caption: 'The house from the street',
    aspect: 'landscape',
    category: 'exterior',
  },
  {
    id: 'PRO-02',
    filename: 'PRO-02.jpg',
    alt: 'Rear garden and fell views from Little Slate House',
    caption: 'The garden with fell views beyond',
    aspect: 'landscape',
    category: 'exterior',
  },
  // Living room
  {
    id: 'PRO-03',
    filename: 'PRO-03.jpg',
    alt: 'Sitting room with wood-burning stove at Little Slate House',
    caption: 'The sitting room and wood burner',
    aspect: 'landscape',
    category: 'interior',
  },
  {
    id: 'PRO-04',
    filename: 'PRO-04.jpg',
    alt: 'Cosy sitting room detail at Little Slate House',
    caption: 'Evening light in the sitting room',
    aspect: 'square',
    category: 'interior',
  },
  // Kitchen / dining
  {
    id: 'PRO-05',
    filename: 'PRO-05.jpg',
    alt: 'Kitchen at Little Slate House fully equipped for self-catering',
    caption: 'The kitchen',
    aspect: 'landscape',
    category: 'kitchen',
  },
  {
    id: 'PRO-06',
    filename: 'PRO-06.jpg',
    alt: 'Dining area at Little Slate House with seating for six',
    caption: 'Dining for six',
    aspect: 'landscape',
    category: 'kitchen',
  },
  // Bedrooms
  {
    id: 'PRO-07',
    filename: 'PRO-07.jpg',
    alt: 'Main bedroom with king-size bed at Little Slate House',
    caption: 'Main bedroom',
    aspect: 'landscape',
    category: 'bedroom',
  },
  {
    id: 'PRO-08',
    filename: 'PRO-08.jpg',
    alt: 'Second bedroom, double, at Little Slate House',
    caption: 'Second bedroom',
    aspect: 'landscape',
    category: 'bedroom',
  },
  {
    id: 'PRO-09',
    filename: 'PRO-09.jpg',
    alt: 'Third bedroom with twin/super-king beds at Little Slate House',
    caption: 'Third bedroom — twin or super-king',
    aspect: 'landscape',
    category: 'bedroom',
  },
  // Boot room
  {
    id: 'PRO-10',
    filename: 'PRO-10.jpg',
    alt: 'Boot room with drying space at Little Slate House',
    caption: 'Boot room — essential for Lakeland walks',
    aspect: 'portrait',
    category: 'interior',
  },
  // Local area — family shots
  {
    id: 'FAM-01',
    filename: 'FAM-01.jpg',
    alt: 'View of Derwentwater from the Keswick shoreline at Fitz Park',
    caption: 'Derwentwater from the shore — ten minutes from the house',
    aspect: 'landscape',
    category: 'area',
  },
  {
    id: 'FAM-02',
    filename: 'FAM-02.jpg',
    alt: 'Catbells ridge walk above Derwentwater in the Lake District',
    caption: 'Catbells — Keswick\'s classic ridge walk',
    aspect: 'landscape',
    category: 'area',
  },
  {
    id: 'FAM-03',
    filename: 'FAM-03.jpg',
    alt: 'Market Square and Moot Hall in Keswick town centre',
    caption: 'Market Square — two minutes from the door',
    aspect: 'landscape',
    category: 'area',
  },
  {
    id: 'FAM-04',
    filename: 'FAM-04.jpg',
    alt: 'Borrowdale valley viewed from above Keswick',
    caption: 'Borrowdale from the fell path',
    aspect: 'landscape',
    category: 'area',
  },
  {
    id: 'FAM-05',
    filename: 'FAM-05.jpg',
    alt: 'Castlerigg Stone Circle at sunset with fell panorama',
    caption: 'Castlerigg Stone Circle — twenty minutes\' walk',
    aspect: 'landscape',
    category: 'area',
  },
  {
    id: 'FAM-06',
    filename: 'FAM-06.jpg',
    alt: 'Latrigg fell summit looking towards Keswick and Derwentwater',
    caption: 'Latrigg — walkable from the house',
    aspect: 'landscape',
    category: 'area',
  },
];
