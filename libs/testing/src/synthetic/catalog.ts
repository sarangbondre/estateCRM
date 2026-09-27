/**
 * Fixed, invented reference lists for synthetic ads. Nothing here is copied from client data:
 * localities and cities are public place names, publications are public newspaper titles, and
 * every building, company, bank and person name is a combination of generic words.
 */
import type { Weighted } from './rng.js';

export interface Locality {
  readonly name: string;
  readonly city: string;
  readonly state: string;
  /** Inside the Mumbai Metropolitan Region (CR-006 Z-7 flag). */
  readonly mmr: boolean;
  /** Residential carpet rate band, INR per sq ft. */
  readonly rate: readonly [number, number];
  /** Relative frequency within its group. */
  readonly weight: number;
  /** Mainly an industrial / MIDC area. */
  readonly industrial?: boolean;
}

function loc(
  name: string,
  city: string,
  rate: readonly [number, number],
  weight: number,
  industrial = false,
): Locality {
  return { name, city, state: 'Maharashtra', mmr: true, rate, weight, industrial };
}

function out(
  name: string,
  city: string,
  state: string,
  rate: readonly [number, number],
  weight: number,
): Locality {
  return { name, city, state, mmr: false, rate, weight };
}

/** Mumbai Metropolitan Region localities (city = the extractor's city column). */
export const MMR_LOCALITIES: readonly Locality[] = [
  // South and central Mumbai
  loc('Colaba', 'Mumbai', [60000, 90000], 12),
  loc('Cuffe Parade', 'Mumbai', [55000, 80000], 10),
  loc('Malabar Hill', 'Mumbai', [70000, 110000], 14),
  loc('Nepean Sea Road', 'Mumbai', [65000, 95000], 10),
  loc('Tardeo', 'Mumbai', [45000, 65000], 10),
  loc('Mahalaxmi', 'Mumbai', [45000, 70000], 10),
  loc('Worli', 'Mumbai', [45000, 75000], 37),
  loc('Lower Parel', 'Mumbai', [40000, 60000], 28),
  loc('Prabhadevi', 'Mumbai', [45000, 65000], 14),
  loc('Dadar West', 'Mumbai', [35000, 50000], 16),
  loc('Wadala', 'Mumbai', [22000, 30000], 8),
  loc('Sion', 'Mumbai', [25000, 35000], 8),
  loc('Fort', 'Mumbai', [35000, 55000], 10),
  loc('Nariman Point', 'Mumbai', [45000, 70000], 12),
  // Western suburbs
  loc('Bandra West', 'Mumbai', [45000, 75000], 66),
  loc('Bandra Kurla Complex', 'Mumbai', [40000, 60000], 20),
  loc('Khar West', 'Mumbai', [40000, 60000], 37),
  loc('Santacruz West', 'Mumbai', [35000, 55000], 22),
  loc('Juhu', 'Mumbai', [45000, 75000], 38),
  loc('Vile Parle West', 'Mumbai', [30000, 45000], 18),
  loc('Vile Parle East', 'Mumbai', [28000, 40000], 10),
  loc('Andheri West', 'Mumbai', [25000, 40000], 56),
  loc('Andheri East', 'Mumbai', [20000, 32000], 30),
  loc('Marol', 'Mumbai', [18000, 26000], 8, true),
  loc('Andheri MIDC', 'Mumbai', [18000, 26000], 8, true),
  loc('Jogeshwari West', 'Mumbai', [20000, 28000], 8),
  loc('Goregaon West', 'Mumbai', [20000, 30000], 16),
  loc('Goregaon East', 'Mumbai', [18000, 27000], 12),
  loc('Malad West', 'Mumbai', [18000, 28000], 14),
  loc('Kandivali West', 'Mumbai', [16000, 25000], 12),
  loc('Borivali West', 'Mumbai', [18000, 27000], 14),
  loc('Dahisar East', 'Mumbai', [14000, 20000], 6),
  // Central and harbour suburbs
  loc('Chembur', 'Mumbai', [22000, 35000], 16),
  loc('Ghatkopar East', 'Mumbai', [22000, 32000], 14),
  loc('Kurla West', 'Mumbai', [18000, 25000], 8),
  loc('Powai', 'Mumbai', [22000, 35000], 26),
  loc('Vikhroli', 'Mumbai', [18000, 28000], 8),
  loc('Kanjurmarg', 'Mumbai', [17000, 26000], 6),
  loc('Mulund West', 'Mumbai', [16000, 24000], 10),
  // Thane district
  loc('Thane West', 'Thane', [13000, 20000], 20),
  loc('Ghodbunder Road', 'Thane', [12000, 17000], 12),
  loc('Majiwada', 'Thane', [13000, 18000], 6),
  loc('Wagle Estate', 'Thane', [10000, 15000], 6, true),
  loc('Kalyan West', 'Kalyan', [7000, 10000], 6),
  loc('Dombivli East', 'Dombivli', [7000, 10000], 6),
  loc('Bhiwandi', 'Bhiwandi', [5000, 8000], 10, true),
  loc('Ambernath MIDC', 'Ambernath', [4500, 7000], 4, true),
  loc('Mira Road East', 'Mira Bhayandar', [10000, 14000], 6),
  loc('Vasai West', 'Vasai', [6000, 9000], 4),
  loc('Virar West', 'Virar', [5000, 8000], 3),
  // Navi Mumbai and Raigad
  loc('Vashi', 'Navi Mumbai', [15000, 22000], 14),
  loc('Nerul', 'Navi Mumbai', [13000, 19000], 8),
  loc('Kharghar', 'Navi Mumbai', [10000, 15000], 10),
  loc('CBD Belapur', 'Navi Mumbai', [11000, 16000], 6),
  loc('Airoli', 'Navi Mumbai', [11000, 16000], 6),
  loc('Ulwe', 'Navi Mumbai', [8000, 11000], 5),
  loc('Turbhe MIDC', 'Navi Mumbai', [8000, 12000], 5, true),
  loc('Rabale MIDC', 'Navi Mumbai', [7000, 11000], 4, true),
  loc('Mahape', 'Navi Mumbai', [9000, 13000], 4, true),
  loc('Taloja MIDC', 'Navi Mumbai', [5000, 8000], 5, true),
  loc('Panvel', 'Panvel', [7000, 11000], 6),
  loc('Karjat', 'Karjat', [4000, 7000], 12),
  loc('Khopoli', 'Khopoli', [3500, 6000], 3),
  loc('Alibag', 'Alibag', [6000, 12000], 6),
];

/** Outside-MMR localities: Maharashtra first (about half, as in the profile), then other states. */
export const OUTSIDE_MMR_LOCALITIES: readonly Locality[] = [
  out('Koregaon Park', 'Pune', 'Maharashtra', [14000, 22000], 8),
  out('Baner', 'Pune', 'Maharashtra', [10000, 15000], 6),
  out('Hinjewadi', 'Pune', 'Maharashtra', [7000, 11000], 5),
  out('Kharadi', 'Pune', 'Maharashtra', [9000, 13000], 5),
  out('Chakan MIDC', 'Pune', 'Maharashtra', [3500, 6000], 4),
  out('Gangapur Road', 'Nashik', 'Maharashtra', [5000, 8000], 6),
  out('Tungarli', 'Lonavala', 'Maharashtra', [6000, 10000], 8),
  out('Panchgani Road', 'Mahabaleshwar', 'Maharashtra', [6000, 10000], 5),
  out('Rajarampuri', 'Kolhapur', 'Maharashtra', [4000, 7000], 3),
  out('SG Highway', 'Ahmedabad', 'Gujarat', [5000, 8000], 5),
  out('Vesu', 'Surat', 'Gujarat', [4500, 7000], 3.5),
  out('Candolim', 'North Goa', 'Goa', [9000, 16000], 4),
  out('Panjim', 'Panaji', 'Goa', [8000, 14000], 3.5),
  out('Adyar', 'Chennai', 'Tamil Nadu', [12000, 20000], 5),
  out('Malviya Nagar', 'Jaipur', 'Rajasthan', [5000, 8000], 4.5),
  out('Salt Lake', 'Kolkata', 'West Bengal', [6000, 10000], 3.5),
  out('Whitefield', 'Bengaluru', 'Karnataka', [7000, 11000], 3.5),
  out('Sector 8', 'Chandigarh', 'Chandigarh', [9000, 14000], 3.5),
  out('Gomti Nagar', 'Lucknow', 'Uttar Pradesh', [5000, 8000], 3),
  out('Vasant Vihar', 'New Delhi', 'Delhi', [25000, 40000], 2),
  out('Rushikonda', 'Visakhapatnam', 'Andhra Pradesh', [5000, 8000], 2),
  out('Chotta Shimla', 'Shimla', 'Himachal Pradesh', [7000, 11000], 2),
  out('Golf Course Road', 'Gurugram', 'Haryana', [14000, 22000], 1.5),
  out('Gachibowli', 'Hyderabad', 'Telangana', [7000, 11000], 1.5),
];

// --- Publications (profile: `source_name`) --------------------------------------------------------

export const NEWSPAPERS: Weighted<string> = [
  ['Times of India', 1323],
  ['Economic Times', 580],
  ['Mumbai Mirror', 107],
  ['Business Standard', 52],
  ['Mid-Day', 51],
  ['Financial Express', 20],
  ['Free Press Journal', 11],
  ['The Hindu', 3],
  ['Hindustan Times', 2],
  ['Navbharat Times', 2],
  ['Business Line', 2],
  ['Gujarat Samachar', 2],
];

export const NEWSPAPER_PAGES: Weighted<number> = [
  [8, 620],
  [6, 414],
  [10, 413],
  [12, 211],
  [14, 94],
  [16, 67],
  [9, 46],
  [4, 43],
  [3, 41],
  [2, 40],
  [1, 38],
  [18, 28],
  [21, 14],
  [7, 14],
];

/** Invented WhatsApp group names. */
export const WHATSAPP_GROUPS: readonly string[] = [
  'Western Suburbs Property Deals',
  'Mumbai Commercial Leasing Circle',
  'Thane Navi Mumbai Resale Network',
  'SoBo Premium Homes Brokers',
  'MMR Land and Industrial Leads',
  'Andheri Powai Rentals',
];

// --- Names (generic words; combinations are invented) ---------------------------------------------

export const FIRST_NAMES: readonly string[] = [
  'Aarav',
  'Aditi',
  'Ajay',
  'Akash',
  'Amit',
  'Ananya',
  'Anil',
  'Anjali',
  'Arjun',
  'Asha',
  'Deepak',
  'Divya',
  'Farhan',
  'Gaurav',
  'Geeta',
  'Harish',
  'Isha',
  'Jatin',
  'Kavita',
  'Kiran',
  'Leena',
  'Mahesh',
  'Manoj',
  'Meera',
  'Mohan',
  'Nandini',
  'Neha',
  'Nikhil',
  'Nisha',
  'Pooja',
  'Pradeep',
  'Priya',
  'Rahul',
  'Rajesh',
  'Rakesh',
  'Ravi',
  'Rekha',
  'Rohan',
  'Sachin',
  'Sameer',
  'Sanjay',
  'Sarita',
  'Shalini',
  'Sneha',
  'Sunil',
  'Sunita',
  'Suresh',
  'Tanvi',
  'Tushar',
  'Uday',
  'Vandana',
  'Varun',
  'Vijay',
  'Vikram',
  'Vinay',
  'Yash',
  'Zoya',
  'Imran',
  'Faisal',
  'Ruksana',
];

export const LAST_NAMES: readonly string[] = [
  'Agarwal',
  'Bhat',
  'Chavan',
  'Desai',
  'Deshmukh',
  'Dsouza',
  'Gandhi',
  'Ghosh',
  'Gupta',
  'Iyer',
  'Jadhav',
  'Jain',
  'Joshi',
  'Kadam',
  'Kapoor',
  'Kulkarni',
  'Mehta',
  'Menon',
  'Mishra',
  'Nair',
  'Naik',
  'Pandey',
  'Parekh',
  'Patel',
  'Patil',
  'Pawar',
  'Pillai',
  'Rao',
  'Reddy',
  'Sawant',
  'Shah',
  'Shaikh',
  'Sharma',
  'Shetty',
  'Shinde',
  'Singh',
  'Sinha',
  'Thakur',
  'Trivedi',
  'Verma',
  'Wagh',
  'Kamath',
  'Fernandes',
  'Khan',
  'Qureshi',
  'Bhosale',
  'More',
  'Gaikwad',
  'Salvi',
  'Rane',
];

const COMPANY_WORDS_A: readonly string[] = [
  'Shreeji',
  'Skyline',
  'Harbour',
  'Lotus',
  'Crescent',
  'Sunrise',
  'Vertex',
  'Silverline',
  'Coastal',
  'Evergreen',
  'Orchid',
  'Bluewave',
  'Keystone',
  'Meridian',
  'Northstar',
  'Pinnacle',
  'Sahyadri',
  'Konkan',
];
const COMPANY_WORDS_B: readonly string[] = [
  'Realty',
  'Estates',
  'Properties',
  'Realtors',
  'Associates',
  'Spaces',
  'Property Consultants',
  'Infra',
];
const DEVELOPER_WORDS_B: readonly string[] = [
  'Developers',
  'Buildcon',
  'Constructions',
  'Homes',
  'Infraprojects',
];

export function companyName(index: number): string {
  const a = COMPANY_WORDS_A[index % COMPANY_WORDS_A.length] as string;
  const b = COMPANY_WORDS_B[Math.floor(index / COMPANY_WORDS_A.length) % COMPANY_WORDS_B.length] as string;
  return `${a} ${b}`;
}

export function developerName(index: number): string {
  const a = COMPANY_WORDS_A[(index * 7 + 3) % COMPANY_WORDS_A.length] as string;
  const b = DEVELOPER_WORDS_B[index % DEVELOPER_WORDS_B.length] as string;
  return `${a} ${b}`;
}

/** Invented lender names for auction notices (not real institutions). */
export const BANKS: readonly string[] = [
  'Western Coast Bank',
  'Deccan Plateau Bank',
  'Arabian Sea Co-operative Bank',
  'Konkan Valley Finance',
  'Sahyadri Hills Bank',
];

export const BUILDING_A: readonly string[] = [
  'Sea Breeze',
  'Silver Oak',
  'Shanti',
  'Sai Krupa',
  'Green Acres',
  'Ocean View',
  'Palm Grove',
  'Sunshine',
  'Royal',
  'Rose Garden',
  'Hill View',
  'Lake Side',
  'Golden',
  'Park View',
  'Samudra',
  'Kailash',
  'Orchid',
];
export const BUILDING_B: readonly string[] = [
  'Tower',
  'Heights',
  'CHS',
  'Residency',
  'Apartments',
  'Enclave',
  'Court',
  'Plaza',
  'Towers',
  'Mansion',
];
export const COMMERCIAL_B: readonly string[] = [
  'Business Park',
  'Corporate Centre',
  'Trade Centre',
  'Commerce House',
  'IT Park',
];
export const PROJECT_B: readonly string[] = [
  'One',
  'Grande',
  'Signature',
  'Avenue',
  'Crest',
  'Serenity',
  'Elite',
];

export const LANDMARKS: readonly string[] = [
  'near metro station',
  'opposite railway station',
  'near highway',
  'behind the municipal garden',
  'near the lake',
  'off Link Road',
  'near the flyover',
  'close to the international airport',
  'walking distance to the beach',
  'next to the shopping mall',
];

export const RESIDENTIAL_FEATURES: readonly string[] = [
  'sea view',
  'garden view',
  'car park',
  '2 car parks',
  'gym',
  'swimming pool',
  'clubhouse',
  'lift',
  '24 hr security',
  'modular kitchen',
  'marble flooring',
  'terrace',
  'high floor',
  'corner flat',
  'east facing',
  'vastu compliant',
  'power backup',
  'children play area',
];

export const COMMERCIAL_FEATURES: readonly string[] = [
  'main road frontage',
  'fully fitted',
  'workstations',
  'cabins',
  'conference room',
  'pantry',
  'central AC',
  'power backup',
  'ample parking',
  'OC received',
  'high ceiling',
  'loading dock',
  'truck access',
  '3 phase power',
  'fire NOC',
];

export const EXTRACTOR_NOTES: readonly string[] = [
  'multiple units in one ad; split',
  'price in lakhs converted',
  'area basis not stated',
  'OCR noise around contact line',
  'locality inferred from landmark',
  'rent and deposit both stated',
  'auction notice; reserve price used as sale price',
  'side inferred from wording',
];

export const BUSINESS_DESCRIPTIONS: Weighted<readonly [string, string]> = [
  [['Manufacturing', 'Running engineering unit with machinery and orders'], 13],
  [['Food and Beverage', 'Running restaurant with licences and staff'], 9],
  [['Hospitality', 'Boutique hotel operating business for sale'], 8],
  [['Real Estate', 'Property brokerage business with client base'], 5],
  [['Education', 'Pre-school franchise with enrolled students'], 4],
  [['Healthcare', 'Diagnostic centre with equipment'], 3],
  [['Technology', 'Software services company seeking partner'], 2],
  [['Agriculture', 'Dairy farm with cattle and land lease'], 2],
  [['Other', 'Printing press running business'], 2],
  [['Distribution', 'FMCG distributorship for western suburbs'], 1],
  [['Media', 'Local cable network business'], 1],
];

export const EQUIPMENT_DETAILS: readonly string[] = [
  'CNC machine',
  'Diesel generator set 250 kVA',
  'Commercial kitchen equipment',
  'Printing machine',
  'Forklift',
  'Injection moulding machine',
];
