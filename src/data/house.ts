export const property = {
  name: 'Little Slate House',
  tagline: 'Three bedrooms in the heart of Keswick',
  type: 'Victorian self-catering cottage',
  sleeps: 6,
  bedrooms: 3,
  location: 'Keswick town centre, Lake District',
  address: {
    town: 'Keswick',
    county: 'Cumbria',
    country: 'England',
    postcode: 'CA12', // general Keswick postcode — fill in exact on go-live
  },
  highlights: [
    'Two minutes from the high street and Market Square',
    'One minute from Fitz Park and the River Greta',
    'Fell views from the upper floors',
    'Short walk to Derwentwater boat landings',
  ],
  instagram: '@littleslatehouse',
  facebook: 'Little Slate House',
  enquiryWebhookUrl: 'PLACEHOLDER_N8N_WEBHOOK_URL', // replace with n8n webhook on go-live

  // WhatsApp click-to-chat — wa.me only, no Cloud API.
  // International format, digits only (no + or spaces).
  // UK example: 07700 900000 → 447700900000
  // Set your real number here before go-live; leave as-is until then.
  whatsappNumber: '6591439074',

  // Pre-filled message that opens in WhatsApp. Edit freely.
  whatsappDefaultMessage:
    "Hi Little Slate House — I'd like to enquire about staying.\n\nDates: \nParty size: \nName: ",
};

export const bedrooms = [
  {
    id: 'bedroom-1',
    name: 'Main bedroom',
    beds: 'King-size double',
    notes: 'Good natural light, fell views',
    floor: 'First floor',
  },
  {
    id: 'bedroom-2',
    name: 'Second bedroom',
    beds: 'Double',
    notes: 'Quiet at the back of the house',
    floor: 'First floor',
  },
  {
    id: 'bedroom-3',
    name: 'Third bedroom',
    beds: 'Two singles (can be made up as twin or pushed together as a super-king)',
    notes: 'Flexible for families or couples',
    floor: 'Second floor',
  },
];

export const amenities = {
  kitchen: [
    'Full oven and hob',
    'Microwave',
    'Dishwasher',
    'Fridge-freezer',
    'Kettle and coffee maker',
    'Toaster',
    'Full cookware and utensils',
  ],
  livingRoom: [
    'Wood-burning stove',
    'Comfortable seating for six',
    'Smart TV',
    'Books and games',
  ],
  practical: [
    'Boot room with drying space',
    'Washing machine',
    'Iron and ironing board',
    'Hair dryer',
    'Travel cot available (bring your own linen)',
    'High chair available',
  ],
  outdoors: [
    'Private outdoor space',
  ],
  wifi: 'Fast broadband Wi-Fi throughout',
  parking: 'On-street parking nearby',
};
