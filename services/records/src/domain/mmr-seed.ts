// Initial Mumbai (MMR) micromarket hierarchy (PRD §3.8): zone → micromarket → locality, with aliases
// (e.g. Andheri East contains Chakala, Marol, MIDC). Admins maintain it afterwards (US-34, R-13).
// Seeded once per tenant; never re-applied over Admin edits.

export interface SeedNode {
  name: string;
  /** Defaults to the zone's (or parent's) city. */
  city?: string;
  aliases?: string[];
  children?: SeedNode[];
}
export interface SeedZone {
  zone: string;
  city: string;
  micromarkets: SeedNode[];
}

const mm = (
  name: string,
  aliases: string[] = [],
  localities: (string | SeedNode)[] = [],
  city?: string,
): SeedNode => ({
  name,
  ...(city ? { city } : {}),
  aliases,
  children: localities.map((l) => (typeof l === 'string' ? { name: l } : l)),
});

export const MMR_SEED: readonly SeedZone[] = [
  {
    zone: 'South Mumbai',
    city: 'Mumbai',
    micromarkets: [
      mm('Colaba', [], ['Cuffe Parade', 'Navy Nagar']),
      mm('Fort', ['Fort Mumbai'], ['Ballard Estate', 'Kala Ghoda']),
      mm('Nariman Point', ['NCPA'], ['Marine Drive', 'Churchgate']),
      mm('Malabar Hill', [], ['Nepean Sea Road', 'Walkeshwar', 'Breach Candy']),
      mm('Tardeo', [], ['Grant Road', 'Kemps Corner']),
      mm('Mahalaxmi', [], ['Haji Ali']),
    ],
  },
  {
    zone: 'Central Mumbai',
    city: 'Mumbai',
    micromarkets: [
      mm('Worli', ['Worli Sea Face'], ['Worli Naka']),
      mm('Lower Parel', ['Parel'], ['Kamala Mills', 'Elphinstone Road']),
      mm('Prabhadevi', [], []),
      mm('Dadar', [], ['Dadar West', 'Dadar East', 'Shivaji Park']),
      mm('Wadala', [], ['Wadala East']),
      mm('Sion', [], ['Matunga']),
    ],
  },
  {
    zone: 'Western Suburbs',
    city: 'Mumbai',
    micromarkets: [
      mm('Bandra West', ['Bandra W', 'Bandra'], ['Pali Hill', 'Carter Road', 'Bandstand']),
      mm('Bandra Kurla Complex', ['BKC', 'Bandra East', 'Bandra E'], []),
      mm('Khar West', ['Khar'], []),
      mm('Santacruz West', ['Santacruz', 'Santa Cruz'], ['Santacruz East']),
      mm('Juhu', [], ['JVPD', 'Juhu Tara Road']),
      mm('Vile Parle West', ['Vile Parle'], ['Vile Parle East']),
      mm('Andheri West', ['Andheri W'], ['Lokhandwala', 'Versova', 'Four Bungalows', 'Oshiwara']),
      mm('Andheri East', ['Andheri E', 'Andheri'], [
        { name: 'Chakala' },
        { name: 'Marol' },
        { name: 'MIDC', aliases: ['Andheri MIDC', 'MIDC Andheri'] },
        { name: 'SEEPZ' },
        { name: 'Saki Naka', aliases: ['Sakinaka'] },
      ]),
      mm('Jogeshwari', ['Jogeshwari West', 'Jogeshwari East'], []),
      mm('Goregaon', ['Goregaon West', 'Goregaon East'], ['Film City Road', 'Aarey Colony']),
      mm('Malad', ['Malad West', 'Malad East'], ['Mindspace Malad']),
      mm('Kandivali', ['Kandivali West', 'Kandivali East'], ['Thakur Village']),
      mm('Borivali', ['Borivali West', 'Borivali East'], []),
      mm('Dahisar', ['Dahisar East', 'Dahisar West'], []),
    ],
  },
  {
    zone: 'Central Suburbs',
    city: 'Mumbai',
    micromarkets: [
      mm('Powai', [], ['Hiranandani Gardens', 'Chandivali']),
      mm('Ghatkopar', ['Ghatkopar East', 'Ghatkopar West'], []),
      mm('Kurla', ['Kurla West', 'Kurla East'], []),
      mm('Vikhroli', ['Vikhroli West', 'Vikhroli East'], ['Kanjurmarg']),
      mm('Bhandup', ['Bhandup West'], []),
      mm('Mulund', ['Mulund West', 'Mulund East'], []),
      mm('Chembur', [], ['Govandi', 'Deonar']),
    ],
  },
  {
    zone: 'Thane',
    city: 'Thane',
    micromarkets: [
      mm('Thane West', ['Thane'], ['Majiwada', 'Kolshet', 'Vartak Nagar']),
      mm('Ghodbunder Road', ['GB Road'], ['Kasarvadavali']),
      mm('Wagle Estate', ['Thane MIDC'], []),
      mm('Kalyan', ['Kalyan West', 'Kalyan East'], [], 'Kalyan'),
      mm('Dombivli', ['Dombivli East', 'Dombivli West'], [], 'Dombivli'),
      mm('Bhiwandi', [], ['Kalher', 'Vadpe'], 'Bhiwandi'),
      mm('Ambernath', ['Ambernath MIDC'], [], 'Ambernath'),
      mm('Badlapur', [], [], 'Badlapur'),
      mm('Ulhasnagar', [], [], 'Ulhasnagar'),
      mm('Mira Road', ['Mira Road East', 'Mira Bhayandar'], ['Bhayandar'], 'Mira Bhayandar'),
      mm('Vasai', ['Vasai West', 'Vasai East'], ['Virar', 'Virar West', 'Nalasopara'], 'Vasai'),
    ],
  },
  {
    zone: 'Navi Mumbai',
    city: 'Navi Mumbai',
    micromarkets: [
      mm('Vashi', [], ['Sanpada', 'Turbhe', { name: 'Turbhe MIDC' }]),
      mm('Nerul', [], ['Seawoods']),
      mm('Belapur', ['CBD Belapur'], []),
      mm('Kharghar', [], []),
      mm('Airoli', [], [{ name: 'Rabale MIDC', aliases: ['Rabale'] }, 'Mahape', 'Ghansoli']),
      mm('Ulwe', [], ['Dronagiri']),
      mm('Panvel', ['New Panvel'], [{ name: 'Taloja MIDC', aliases: ['Taloja'] }], 'Panvel'),
    ],
  },
  {
    zone: 'Raigad',
    city: 'Raigad',
    micromarkets: [mm('Karjat', [], [], 'Karjat'), mm('Khopoli', [], [], 'Khopoli'), mm('Alibag', ['Alibaug'], [], 'Alibag'), mm('Uran', [], [], 'Uran')],
  },
];
