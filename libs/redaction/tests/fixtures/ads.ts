import type { PiiKind } from '../../src/index.js';

/**
 * Synthetic test set in the style of Mumbai newspaper and WhatsApp property ads (F-14).
 *
 * Everything here is invented. Phone numbers use obviously synthetic patterns (90000 0xxxx, 80000 0xxxx,
 * 70000 0xxxx, 60000 0xxxx, 98765 43210, 022-2000 0xxx); e-mails use example.com / example.in; names are common
 * first names and surnames with no link to any real person. No value is taken from the real extractor file.
 *
 * Each case lists the exact PII spans that must disappear (`pii`) and the non-PII substrings the model needs, which
 * must survive unchanged (`keep`).
 */
export interface Pii {
  readonly kind: PiiKind;
  readonly value: string;
}

export interface AdCase {
  readonly id: string;
  readonly text: string;
  readonly pii: readonly Pii[];
  readonly keep: readonly string[];
}

type P = readonly [PiiKind, string];

let n = 0;
function ad(text: string, pii: readonly P[], keep: readonly string[] = []): AdCase {
  n += 1;
  return {
    id: `ad-${String(n).padStart(3, '0')}`,
    text,
    pii: pii.map(([kind, value]) => ({ kind, value })),
    keep,
  };
}

/** Ads with personal data. */
export const PII_ADS: readonly AdCase[] = [
  // --- Newspaper supply ads -------------------------------------------------------------------------------------
  ad(
    'Andheri West, 2BHK 850 sq.ft carpet, 12th floor, Sai Krupa CHS, Flat 1203, Rs 1.85 Cr neg. Contact Sanjay 90000 01234',
    [
      ['UNIT', '1203'],
      ['NAME', 'Sanjay'],
      ['PHONE', '90000 01234'],
    ],
    ['Andheri West', '2BHK', '850 sq.ft', '12th floor', 'Sai Krupa CHS', '1.85 Cr'],
  ),
  ad(
    'POWAI Hiranandani 3BHK for sale, 1450 sqft, Rs 3.2 Cr, owner Mr. Rakesh Mehta 98765 43210, brokers excuse',
    [
      ['NAME', 'Rakesh Mehta'],
      ['PHONE', '98765 43210'],
    ],
    ['POWAI', 'Hiranandani', '3BHK', '1450 sqft', '3.2 Cr', 'brokers excuse'],
  ),
  ad(
    'Bandra W sea facing 4BHK on rent 6.5L pm, deposit 30L. Call +91 90000 02345 / 46',
    [
      ['PHONE', '+91 90000 02345'],
      ['PHONE', '/ 46'],
    ],
    ['Bandra W', '4BHK', '6.5L pm', '30L'],
  ),
  ad(
    'Wanted 1BHK on rent in Malad/Goregaon East upto 25k, family, contact Priya 80000 03456',
    [
      ['NAME', 'Priya'],
      ['PHONE', '80000 03456'],
    ],
    ['1BHK', 'Malad/Goregaon East', '25k'],
  ),
  ad(
    'Office 405, 4th floor, Kalpataru Square, Andheri East near Chakala, 1200 sq ft furnished, 1.1L rent. Mob: 9000004567 (Rajesh)',
    [
      ['UNIT', '405'],
      ['PHONE', '9000004567'],
      ['NAME', 'Rajesh'],
    ],
    ['4th floor', 'Kalpataru Square', 'Andheri East', '1200 sq ft', '1.1L'],
  ),
  ad(
    'MIDC Andheri industrial gala 3000 sqft, 3 phase power, Gala No. 12, rent 2.5L. Tel 022-2000 0567',
    [
      ['UNIT', 'No. 12'],
      ['PHONE', '022-2000 0567'],
    ],
    ['MIDC', '3000 sqft', '3 phase', '2.5L'],
  ),
  ad(
    'Bhiwandi warehouse 50,000 sq ft on NH-3, ht 40 ft, for lease @ Rs 22/sqft. Broker Imran Khan 7000005678',
    [
      ['NAME', 'Imran Khan'],
      ['PHONE', '7000005678'],
    ],
    ['Bhiwandi', '50,000 sq ft', 'NH-3', '40 ft', '@ Rs 22/sqft'],
  ),
  ad(
    'Thane (W) Ghodbunder Rd 2BHK 1.1 Cr, B-wing 702, Lodha Amara, ready possession, OC recd. WhatsApp wa.me/919000006789',
    [
      ['UNIT', 'B-wing 702'],
      ['URL', 'wa.me/919000006789'],
    ],
    ['Thane (W)', 'Ghodbunder Rd', '1.1 Cr', 'Lodha Amara', 'ready possession'],
  ),
  ad(
    'Khar W, 3BHK, 1600 carpet, 7th flr, Rs 5.75 Cr. Contact: sanjay.fake@example.com',
    [['EMAIL', 'sanjay.fake@example.com']],
    ['Khar W', '3BHK', '1600 carpet', '7th flr', '5.75 Cr'],
  ),
  ad(
    'Juhu bungalow plot 800 sq yd for JV with builders. Owners only. Email owner.fake at example dot com',
    [['EMAIL', 'owner.fake at example dot com']],
    ['Juhu', '800 sq yd', 'JV'],
  ),
  ad(
    'Worli 3BHK sea view, 2100 sqft, 32nd floor, Rs 12 Cr. Contact Mrs. Anjali Desai 9876543210',
    [
      ['NAME', 'Anjali Desai'],
      ['PHONE', '9876543210'],
    ],
    ['Worli', '2100 sqft', '32nd floor', '12 Cr'],
  ),
  ad(
    'Chembur 2BHK resale 95L, Flat No. A-503, Shanti Niketan, near Diamond Garden. Ph: 022 2000 0678',
    [
      ['UNIT', 'A-503'],
      ['PHONE', '022 2000 0678'],
    ],
    ['Chembur', '2BHK', '95L', 'Shanti Niketan', 'Diamond Garden'],
  ),
  ad(
    'Mulund W 1BHK 650 sq ft 78 lakh, owner direct. Call Suresh Patil 90000-01122',
    [
      ['NAME', 'Suresh Patil'],
      ['PHONE', '90000-01122'],
    ],
    ['Mulund W', '650 sq ft', '78 lakh', 'owner direct'],
  ),
  ad(
    'Dadar W shop 350 sqft on main road, Shop No. 5, Ranade Road, rent 1.2L. Contact 80000.01133',
    [
      ['UNIT', 'No. 5'],
      ['PHONE', '80000.01133'],
    ],
    ['Dadar W', '350 sqft', 'Ranade Road', '1.2L'],
  ),
  ad(
    'Borivali E 2BHK 1.35 Cr, Wing C 1104, Oberoi Sky City, 11th floor. Ramesh 9000.012.345',
    [
      ['UNIT', 'Wing C 1104'],
      ['NAME', 'Ramesh'],
      ['PHONE', '9000.012.345'],
    ],
    ['Borivali E', '1.35 Cr', 'Oberoi Sky City', '11th floor'],
  ),
  ad(
    'Kandivali W 3BHK 1250 carpet Rs 2.4 Cr. Contact 90-0001-2345, brokers welcome',
    [['PHONE', '90-0001-2345']],
    ['Kandivali W', '1250 carpet', '2.4 Cr', 'brokers welcome'],
  ),
  ad(
    'Santacruz E office 800 sqft near Vakola, rent 90k. Call 9 0 0 0 0 1 2 3 4 5',
    [['PHONE', '9 0 0 0 0 1 2 3 4 5']],
    ['Santacruz E', '800 sqft', 'Vakola', '90k'],
  ),
  ad(
    'Goregaon E 2BHK 1.6 Cr near Oberoi Mall. Mob 9OOOO 1O234',
    [['PHONE', '9OOOO 1O234']],
    ['Goregaon E', '1.6 Cr', 'Oberoi Mall'],
  ),
  ad(
    'Vile Parle E 2BHK rent 75k, Room No 12, Nehru Road. Contact Kiran - 7000001144',
    [
      ['UNIT', 'No 12'],
      ['NAME', 'Kiran'],
      ['PHONE', '7000001144'],
    ],
    ['Vile Parle E', '75k', 'Nehru Road'],
  ),
  ad(
    'Lower Parel office 5000 sqft Grade A, Rs 2.8L pm. Contact Neha Kapoor, neha.k@example.in, 90000 01155',
    [
      ['NAME', 'Neha Kapoor'],
      ['EMAIL', 'neha.k@example.in'],
      ['PHONE', '90000 01155'],
    ],
    ['Lower Parel', '5000 sqft', 'Grade A', '2.8L pm'],
  ),
  ad(
    'Ghatkopar E 1BHK 68L, Pant Nagar, 3rd floor. Tel: (022) 2000 0789',
    [['PHONE', '(022) 2000 0789']],
    ['Ghatkopar E', '68L', 'Pant Nagar', '3rd floor'],
  ),
  ad(
    'Nerul sector 19, 2BHK 1.05 Cr, 9th floor, CIDCO plot. Phone 0 9000 001166',
    [['PHONE', '0 9000 001166']],
    ['Nerul', 'sector 19', '1.05 Cr', '9th floor', 'CIDCO'],
  ),
  ad(
    'Vashi 3BHK 2.1 Cr, sector 17, 1400 sqft. Call 91-90000-01177',
    [['PHONE', '91-90000-01177']],
    ['Vashi', 'sector 17', '2.1 Cr', '1400 sqft'],
  ),
  ad(
    'Kharghar 2BHK rent 28k, Unit 7, Sai Sparsh. Mr Deshmukh 8000001188',
    [
      ['UNIT', '7'],
      ['NAME', 'Deshmukh'],
      ['PHONE', '8000001188'],
    ],
    ['Kharghar', '28k', 'Sai Sparsh'],
  ),
  ad(
    'Panvel NA plot 5000 sqft, 45 lakh. Contact Shri Vitthal Jadhav 7000001199',
    [
      ['NAME', 'Vitthal Jadhav'],
      ['PHONE', '7000001199'],
    ],
    ['Panvel', 'NA plot', '5000 sqft', '45 lakh'],
  ),
  ad(
    'Alibaug farmhouse 1 acre with bungalow, Rs 4.5 Cr. Smt. Kavita Rane 9000001200',
    [
      ['NAME', 'Kavita Rane'],
      ['PHONE', '9000001200'],
    ],
    ['Alibaug', '1 acre', '4.5 Cr'],
  ),
  ad(
    "Colaba 2BHK heritage bldg, 1100 sqft, rent 1.5L. Contact Ms. Farah D'Souza 90000 01211",
    [
      ['NAME', "Farah D'Souza"],
      ['PHONE', '90000 01211'],
    ],
    ['Colaba', '1100 sqft', '1.5L'],
  ),
  ad(
    'Bandra W, Pali Hill 4BHK duplex 12 Cr. Contact Dr. Arun Iyer +91-90000-01222',
    [
      ['NAME', 'Arun Iyer'],
      ['PHONE', '+91-90000-01222'],
    ],
    ['Pali Hill', '4BHK', '12 Cr'],
  ),
  ad(
    'Mira Road 1BHK 55L, 630 sqft, Flat 304, Poonam Sagar. Contact 90000 01233/34',
    [
      ['UNIT', '304'],
      ['PHONE', '90000 01233/34'],
    ],
    ['Mira Road', '55L', '630 sqft', 'Poonam Sagar'],
  ),
  ad(
    'Dombivli E 2BHK 62 lakh, 5 min from station. Contact 7000001244, 7000001255',
    [
      ['PHONE', '7000001244'],
      ['PHONE', '7000001255'],
    ],
    ['Dombivli E', '62 lakh', '5 min'],
  ),
  // --- WhatsApp broker forwards ---------------------------------------------------------------------------------
  ad(
    '*Fresh listing* 2bhk andheri east chakala 1.4cr neg call/wa 90000 01266 sanjay',
    [
      ['PHONE', '90000 01266'],
      ['NAME', 'sanjay'],
    ],
    ['2bhk', 'andheri east', 'chakala', '1.4cr'],
  ),
  ad(
    'rent 1rk powai 18k only family. sanjay 9000001277',
    [
      ['NAME', 'sanjay'],
      ['PHONE', '9000001277'],
    ],
    ['1rk', 'powai', '18k'],
  ),
  ad(
    'Urgent sale!! 3BHK Kandivali East Thakur Village 1.9 Cr. Rahul bhai 8000001288',
    [
      ['NAME', 'Rahul'],
      ['PHONE', '8000001288'],
    ],
    ['3BHK', 'Thakur Village', '1.9 Cr'],
  ),
  ad(
    'Office for rent BKC 3000 sqft 6L pm plug n play. Contact Mehta ji +919000001299',
    [
      ['NAME', 'Mehta'],
      ['PHONE', '+919000001299'],
    ],
    ['BKC', '3000 sqft', '6L pm'],
  ),
  ad(
    '2 bhk sale malad west evershine nagar 1.15cr call 70000-01300 priya',
    [
      ['PHONE', '70000-01300'],
      ['NAME', 'priya'],
    ],
    ['2 bhk', 'malad west', 'evershine nagar', '1.15cr'],
  ),
  ad(
    'Requirement: 2BHK rent Bandra/Khar budget 1L. Client ready. Broker Vikas 90000 01311',
    [
      ['NAME', 'Vikas'],
      ['PHONE', '90000 01311'],
    ],
    ['2BHK', 'Bandra/Khar', '1L'],
  ),
  ad(
    'Shop for sale Borivali W, Shop 14, Chandavarkar Rd, 250 sqft 85L. Deepak Shah 9000001322',
    [
      ['UNIT', '14'],
      ['NAME', 'Deepak Shah'],
      ['PHONE', '9000001322'],
    ],
    ['Borivali W', 'Chandavarkar Rd', '250 sqft', '85L'],
  ),
  ad(
    'Hi team, new inventory: Powai 2BHK 1.75cr Lake Homes, flat C-1502. Regards, Amit Joshi 8000001333',
    [
      ['UNIT', 'C-1502'],
      ['NAME', 'Amit Joshi'],
      ['PHONE', '8000001333'],
    ],
    ['Powai', '2BHK', '1.75cr', 'Lake Homes'],
  ),
  ad(
    'Leave & license 1BHK Sion 32k, deposit 1.5L. Pls call 7000001344 (Pooja)',
    [
      ['PHONE', '7000001344'],
      ['NAME', 'Pooja'],
    ],
    ['Sion', '32k', '1.5L'],
  ),
  ad(
    'Thane Majiwada 2bhk 1.2cr contact sameer 90000 01355',
    [
      ['NAME', 'sameer'],
      ['PHONE', '90000 01355'],
    ],
    ['Majiwada', '2bhk', '1.2cr'],
  ),
  ad(
    'WA 9000001366 for Chandivali office 1500 sqft rent 1.3L',
    [['PHONE', '9000001366']],
    ['Chandivali', '1500 sqft', '1.3L'],
  ),
  ad(
    'Ready office in Andheri E, Times Square, Unit No. 1107, 2200 sqft, 2.2L. Contact Harish 80000 01377 / 80000 01388',
    [
      ['UNIT', '1107'],
      ['NAME', 'Harish'],
      ['PHONE', '80000 01377'],
      ['PHONE', '80000 01388'],
    ],
    ['Andheri E', 'Times Square', '2200 sqft', '2.2L'],
  ),
  ad(
    'Villa in Lonavala 3BHK private pool 3.5 Cr. Visit www.example-villas.in or mail sales@example-villas.in',
    [
      ['URL', 'www.example-villas.in'],
      ['EMAIL', 'sales@example-villas.in'],
    ],
    ['Lonavala', '3BHK', '3.5 Cr'],
  ),
  ad(
    'Details at https://example.com/listing/4521?ref=wa call 7000001399',
    [
      ['URL', 'https://example.com/listing/4521?ref=wa'],
      ['PHONE', '7000001399'],
    ],
    [],
  ),
  ad(
    'Studio apt Lokhandwala 45k rent. Contact Rohit 90000 01400. Brokers excuse',
    [
      ['NAME', 'Rohit'],
      ['PHONE', '90000 01400'],
    ],
    ['Lokhandwala', '45k', 'Brokers excuse'],
  ),
  // --- Demand ads -----------------------------------------------------------------------------------------------
  ad(
    'Wanted 3BHK to buy in Powai/Vikhroli budget 2.5-3 Cr, ready possession. NRI buyer. Contact Mr. Nair 9000001411',
    [
      ['NAME', 'Nair'],
      ['PHONE', '9000001411'],
    ],
    ['3BHK', 'Powai/Vikhroli', '2.5-3 Cr', 'NRI'],
  ),
  ad(
    'Looking for 10,000 sqft warehouse in Bhiwandi, rent upto 20/sqft. Contact Logistics Manager Arjun Rao 80000 01422',
    [
      ['NAME', 'Arjun Rao'],
      ['PHONE', '80000 01422'],
    ],
    ['10,000 sqft', 'Bhiwandi', '20/sqft'],
  ),
  ad(
    'Company requires office 2000-2500 sqft in Andheri E / Powai on lease. Email facilities.fake@example.com',
    [['EMAIL', 'facilities.fake@example.com']],
    ['2000-2500 sqft', 'Andheri E / Powai'],
  ),
  ad(
    'Doctor needs clinic space 400 sqft ground floor in Chembur. Dr. Meera Kulkarni 9000001433',
    [
      ['NAME', 'Meera Kulkarni'],
      ['PHONE', '9000001433'],
    ],
    ['400 sqft', 'ground floor', 'Chembur'],
  ),
  ad(
    'Want to buy industrial land 5-10 acres near Taloja/Khopoli. Contact: Karan Malhotra, 7000001444',
    [
      ['NAME', 'Karan Malhotra'],
      ['PHONE', '7000001444'],
    ],
    ['5-10 acres', 'Taloja/Khopoli'],
  ),
  ad(
    'Family looking 2BHK rent Thane W, 30-35k, near Viviana Mall. Call Sneha 90000 01455',
    [
      ['NAME', 'Sneha'],
      ['PHONE', '90000 01455'],
    ],
    ['2BHK', 'Thane W', '30-35k', 'Viviana Mall'],
  ),
  ad(
    'Buyer for 1BHK Dahisar upto 60L, loan approved. Contact Ajay 9000-001-466',
    [
      ['NAME', 'Ajay'],
      ['PHONE', '9000-001-466'],
    ],
    ['1BHK', 'Dahisar', '60L'],
  ),
  ad(
    'Req. showroom 3000 sqft on SV Road Bandra to Malad, budget 5L. Email: retail.fake(at)example.com',
    [['EMAIL', 'retail.fake(at)example.com']],
    ['3000 sqft', 'SV Road', '5L'],
  ),
  ad(
    'Need bungalow on rent in Juhu for film shoot, 2 months. Contact Farhan 80000 01477 or farhan.fake[at]example[dot]in',
    [
      ['NAME', 'Farhan'],
      ['PHONE', '80000 01477'],
      ['EMAIL', 'farhan.fake[at]example[dot]in'],
    ],
    ['Juhu', '2 months'],
  ),
  ad(
    'Investor wants pre-leased commercial 5-8 Cr, 8% yield, Mumbai. Contact CA Rajiv Bansal 9000001488',
    [
      ['NAME', 'Rajiv Bansal'],
      ['PHONE', '9000001488'],
    ],
    ['5-8 Cr', '8% yield'],
  ),
  // --- Commercial / industrial ----------------------------------------------------------------------------------
  ad(
    'MIDC Mahape industrial shed 8000 sqft, Plot No. W-45, 150 HP power, lease 4L pm. Contact 022-2000 0890',
    [
      ['UNIT', 'W-45'],
      ['PHONE', '022-2000 0890'],
    ],
    ['MIDC Mahape', '8000 sqft', '150 HP', '4L pm'],
  ),
  ad(
    'Taloja MIDC plot 2 acres, Plot No. T-12, Rs 9 Cr. Contact Anil 9000001499',
    [
      ['UNIT', 'T-12'],
      ['NAME', 'Anil'],
      ['PHONE', '9000001499'],
    ],
    ['Taloja MIDC', '2 acres', '9 Cr'],
  ),
  ad(
    'Godown No. 7 at Bhiwandi Kalher, 12000 sqft, 30 ft height, rent 18/sqft. Imran Shaikh 7000001500',
    [
      ['UNIT', 'No. 7'],
      ['NAME', 'Imran Shaikh'],
      ['PHONE', '7000001500'],
    ],
    ['Bhiwandi', 'Kalher', '12000 sqft', '30 ft', '18/sqft'],
  ),
  ad(
    'Showroom Linking Road Khar, ground+1, 2500 sqft, rent 12L. Contact Mr. Sabharwal on 9000001511',
    [
      ['NAME', 'Sabharwal'],
      ['PHONE', '9000001511'],
    ],
    ['Linking Road', '2500 sqft', '12L'],
  ),
  ad(
    'Co-working 50 seats Andheri E, Rs 8,500 per seat. Contact team@example-cowork.com / 80000 01522',
    [
      ['EMAIL', 'team@example-cowork.com'],
      ['PHONE', '80000 01522'],
    ],
    ['50 seats', 'Andheri E', 'Rs 8,500 per seat'],
  ),
  ad(
    'Pre-leased bank branch, Ghatkopar W, 3000 sqft, rent 4.5L, 9 yr lease, price 7.5 Cr. Contact Gupta 90000 01533',
    [
      ['NAME', 'Gupta'],
      ['PHONE', '90000 01533'],
    ],
    ['Ghatkopar W', '3000 sqft', '4.5L', '9 yr lease', '7.5 Cr'],
  ),
  ad(
    'Office #804, Lodha Supremus, Thane Wagle Estate, 1100 sqft furnished rent 85k. Call 70000 01544',
    [
      ['UNIT', '804'],
      ['PHONE', '70000 01544'],
    ],
    ['Lodha Supremus', 'Wagle Estate', '1100 sqft', '85k'],
  ),
  ad(
    'Hotel for sale in Lonavala, 24 rooms, 1 acre, 22 Cr. Contact owner Mr. Patel 9000001555',
    [
      ['NAME', 'Patel'],
      ['PHONE', '9000001555'],
    ],
    ['Lonavala', '24 rooms', '1 acre', '22 Cr'],
  ),
  ad(
    'Factory with machinery at Vasai, Gala 5-B, 6000 sqft, sale 3.2 Cr. Contact Prakash 80000 01566',
    [
      ['UNIT', '5-B'],
      ['NAME', 'Prakash'],
      ['PHONE', '80000 01566'],
    ],
    ['Vasai', '6000 sqft', '3.2 Cr'],
  ),
  ad(
    'Land at Karjat, Survey No. 45/2, 3 acres NA, 1.8 Cr. Contact Balasaheb Pawar 9000001577',
    [
      ['UNIT', '45/2'],
      ['NAME', 'Balasaheb Pawar'],
      ['PHONE', '9000001577'],
    ],
    ['Karjat', '3 acres', '1.8 Cr'],
  ),
  ad(
    'Agri land Shahapur Gat No. 112, 10 acres, Rs 30 lakh per acre. Call Ganesh 7000001588',
    [
      ['UNIT', '112'],
      ['NAME', 'Ganesh'],
      ['PHONE', '7000001588'],
    ],
    ['Shahapur', '10 acres', '30 lakh per acre'],
  ),
  ad(
    'Plot 23, Sector 8, Ulwe, 250 sq m, CIDCO lease, 1.4 Cr. Contact 90000 01599',
    [
      ['UNIT', 'Plot 23'],
      ['PHONE', '90000 01599'],
    ],
    ['Sector 8', 'Ulwe', '250 sq m', 'CIDCO', '1.4 Cr'],
  ),
  // --- Auctions / notices (business data kept, individual contacts masked) ------------------------------------
  ad(
    'E-AUCTION under SARFAESI. Flat No. 902, B Wing, Sunshine Heights, Mira Road. Reserve price Rs 72,00,000, EMD Rs 7,20,000. Authorised Officer 022-2000 0911',
    [
      ['UNIT', '902'],
      ['UNIT', 'B Wing'],
      ['PHONE', '022-2000 0911'],
    ],
    ['SARFAESI', 'Sunshine Heights', 'Mira Road', 'Rs 72,00,000', 'Rs 7,20,000'],
  ),
  ad(
    'PUBLIC NOTICE: my client Shri Mahesh Gawde intends to purchase Flat No. 11, Anand Niwas, Dadar. Adv. Sunil Mhatre, 8000001600',
    [
      ['NAME', 'Mahesh Gawde'],
      ['UNIT', '11'],
      ['NAME', 'Sunil Mhatre'],
      ['PHONE', '8000001600'],
    ],
    ['Anand Niwas', 'Dadar'],
  ),
  ad(
    'Bank auction: Shop No. G-4, Vardhman Plaza, Kalyan W, 300 sqft, reserve 38 lakh. Contact 9000001611',
    [
      ['UNIT', 'G-4'],
      ['PHONE', '9000001611'],
    ],
    ['Vardhman Plaza', 'Kalyan W', '300 sqft', '38 lakh'],
  ),
  ad(
    'Tender notice: redevelopment of Om Sai CHS, Goregaon W, 40 members. Secretary Mr. Kadam 70000 01622',
    [
      ['NAME', 'Kadam'],
      ['PHONE', '70000 01622'],
    ],
    ['Om Sai CHS', 'Goregaon W', '40 members'],
  ),
  ad(
    'Auction of industrial unit Plot No. A-78, TTC MIDC Turbhe, 1000 sq m. Inspection contact Mr. R. K. Sinha 9000001633',
    [
      ['UNIT', 'A-78'],
      ['NAME', 'R. K. Sinha'],
      ['PHONE', '9000001633'],
    ],
    ['TTC MIDC Turbhe', '1000 sq m'],
  ),
  // --- Obfuscation and odd formatting ---------------------------------------------------------------------------
  ad('Andheri 2BHK. Call nine 9000.00.1644 now', [['PHONE', '9000.00.1644']], ['Andheri', '2BHK']),
  ad('Powai 1BHK rent 40k Ph:+91 9000 001 655', [['PHONE', '+91 9000 001 655']], ['Powai', '1BHK', '40k']),
  ad('Malad office 700 sqft. Mob.8000001666', [['PHONE', '8000001666']], ['Malad', '700 sqft']),
  ad('Contact @ 70000 01677 for Bandra 3BHK', [['PHONE', '70000 01677']], ['Bandra', '3BHK']),
  ad('Sale 2bhk Thane 1cr call 9000O01688', [['PHONE', '9000O01688']], ['2bhk', 'Thane', '1cr']),
  ad('Rent Kurla 1BHK 25k Tel.022-20001699', [['PHONE', '022-20001699']], ['Kurla', '1BHK', '25k']),
  ad(
    'Mail: flats4u.fake @ example.com for Vikhroli listings',
    [['EMAIL', 'flats4u.fake @ example.com']],
    ['Vikhroli'],
  ),
  ad(
    'Contact broker.fake{at}example.com / 0091 90000 01700',
    [
      ['EMAIL', 'broker.fake{at}example.com'],
      ['PHONE', '0091 90000 01700'],
    ],
    [],
  ),
  ad('Tel 2000 1711 (office) for Fort premises 600 sqft', [['PHONE', '2000 1711']], ['Fort', '600 sqft']),
  ad(
    'Mob: 90000 01722, 90000 01733, 90000 01744 — Andheri office',
    [
      ['PHONE', '90000 01722'],
      ['PHONE', '90000 01733'],
      ['PHONE', '90000 01744'],
    ],
    ['Andheri'],
  ),
  ad('Contact +91 (900) 000-1755 for Kurla 2BHK', [['PHONE', '+91 (900) 000-1755']], ['Kurla', '2BHK']),
  ad(
    'Toll free 1800 200 1766 for new launch in Thane, 2BHK from 89L',
    [['PHONE', '1800 200 1766']],
    ['Thane', '2BHK', '89L'],
  ),
  ad(
    'Owner: Sanjay Kulkarni / 90000 01777 / sanjayk.fake@example.com',
    [
      ['NAME', 'Sanjay Kulkarni'],
      ['PHONE', '90000 01777'],
      ['EMAIL', 'sanjayk.fake@example.com'],
    ],
    [],
  ),
  ad('Call 080000 01788 for Kalyan plots', [['PHONE', '080000 01788']], ['Kalyan']),
  ad(
    'ph 9000001799/800 Andheri 2 bhk',
    [
      ['PHONE', '9000001799'],
      ['PHONE', '/800'],
    ],
    ['Andheri', '2 bhk'],
  ),
  ad(
    'Contact on WhatsApp https://wa.me/917000001811?text=Hi for Powai rentals',
    [['URL', 'https://wa.me/917000001811?text=Hi']],
    ['Powai'],
  ),
  ad(
    'Contact (Manoj) 70000 01822',
    [
      ['NAME', 'Manoj'],
      ['PHONE', '70000 01822'],
    ],
    [],
  ),
  ad(
    'Flat 12B, Rizvi Park, Santacruz W, 2BHK rent 85k. 9000001833',
    [
      ['UNIT', '12B'],
      ['PHONE', '9000001833'],
    ],
    ['Rizvi Park', 'Santacruz W', '2BHK', '85k'],
  ),
  ad(
    '1203, Sai Darshan Tower, Kandivali W. 2BHK sale 1.5 Cr. Contact Nilesh 80000 01844',
    [
      ['UNIT', '1203'],
      ['NAME', 'Nilesh'],
      ['PHONE', '80000 01844'],
    ],
    ['Sai Darshan Tower', 'Kandivali W', '1.5 Cr'],
  ),
  ad(
    '302, A Wing, Gokul Heights, Borivali E. Owner Hemant 7000001855',
    [
      ['UNIT', '302'],
      ['UNIT', 'A Wing'],
      ['NAME', 'Hemant'],
      ['PHONE', '7000001855'],
    ],
    ['Gokul Heights', 'Borivali E'],
  ),
  ad(
    'CALL SANJAY MEHTA 9000001866 FOR 2BHK IN ANDHERI',
    [
      ['NAME', 'SANJAY MEHTA'],
      ['PHONE', '9000001866'],
    ],
    ['2BHK', 'ANDHERI'],
  ),
  ad(
    'CONTACT MR. DESAI 80000 01877 - WORLI OFFICE 3000 SQFT',
    [
      ['NAME', 'DESAI'],
      ['PHONE', '80000 01877'],
    ],
    ['WORLI', '3000 SQFT'],
  ),
  ad(
    'Speak to Arvind (9000001888) about the Powai 3BHK',
    [
      ['NAME', 'Arvind'],
      ['PHONE', '9000001888'],
    ],
    ['Powai', '3BHK'],
  ),
  ad(
    'Posted by Sunita Rao, 9000001899',
    [
      ['NAME', 'Sunita Rao'],
      ['PHONE', '9000001899'],
    ],
    [],
  ),
  ad(
    'Enquiries: Vinod Kumar | 90000 01900 | vinodk.fake@example.in',
    [
      ['NAME', 'Vinod Kumar'],
      ['PHONE', '90000 01900'],
      ['EMAIL', 'vinodk.fake@example.in'],
    ],
    [],
  ),
  ad(
    'Contact Fernandes sir 7000001911 for Bandra flat',
    [
      ['NAME', 'Fernandes'],
      ['PHONE', '7000001911'],
    ],
    ['Bandra'],
  ),
  ad(
    'Patil saheb 9000001922 has 3 plots in Karjat',
    [
      ['NAME', 'Patil'],
      ['PHONE', '9000001922'],
    ],
    ['3 plots', 'Karjat'],
  ),
  ad(
    'Flat A/1402 Runwal Greens Mulund, 3BHK 2.3 Cr',
    [['UNIT', 'A/1402']],
    ['Runwal Greens', 'Mulund', '3BHK', '2.3 Cr'],
  ),
  ad(
    'Shop no.3 ground floor Ghatkopar W 90 lakh',
    [['UNIT', 'no.3']],
    ['ground floor', 'Ghatkopar W', '90 lakh'],
  ),
  ad(
    'Bungalow No 17, Model Town, Andheri W for redevelopment',
    [['UNIT', 'No 17']],
    ['Model Town', 'Andheri W'],
  ),
  ad(
    'Office Unit 5, 2nd floor, Sagar Tech Plaza, Saki Naka, 600 sqft, 60k',
    [['UNIT', 'Unit 5']],
    ['2nd floor', 'Sagar Tech Plaza', 'Saki Naka', '600 sqft', '60k'],
  ),
  ad(
    'Room 4, Chawl No. 2, Lalbaug, pagdi 35 lakh',
    [
      ['UNIT', 'Room 4'],
      ['UNIT', 'No. 2'],
    ],
    ['Lalbaug', 'pagdi', '35 lakh'],
  ),
  ad(
    'PAN ABCPE1234F and Aadhaar 2345 6789 0123 of seller verified; Powai 2BHK',
    [
      ['ID', 'ABCPE1234F'],
      ['ID', '2345 6789 0123'],
    ],
    ['Powai', '2BHK'],
  ),
  ad('Bank a/c 123456789012 for token payment, Thane 1BHK', [['ID', '123456789012']], ['Thane', '1BHK']),
  // --- Hinglish / Marathi / Devanagari --------------------------------------------------------------------------
  ad(
    '2BHK Andheri me sale hai 1.3 Cr, sampark karein Rakesh 90000 01933',
    [
      ['NAME', 'Rakesh'],
      ['PHONE', '90000 01933'],
    ],
    ['2BHK', 'Andheri', '1.3 Cr'],
  ),
  ad(
    'Dukaan kiraye pe Dadar, 200 sqft, sampark 7000001944',
    [['PHONE', '7000001944']],
    ['Dadar', '200 sqft'],
  ),
  ad(
    'Thane madhe 1BHK vikne aahe, 65 lakh. Sampark kara Sachin 9000001955',
    [
      ['NAME', 'Sachin'],
      ['PHONE', '9000001955'],
    ],
    ['Thane', '1BHK', '65 lakh'],
  ),
  ad(
    'दादर मध्ये 1BHK विक्री, संपर्क: सुनील पाटील ९०००० ०१९६६',
    [
      ['NAME', 'सुनील पाटील'],
      ['PHONE', '९०००० ०१९६६'],
    ],
    ['दादर', '1BHK'],
  ),
  ad('अंधेरी 2BHK किराये पर, फोन ७००००-०१९७७', [['PHONE', '७००००-०१९७७']], ['अंधेरी', '2BHK']),
  ad(
    'Kalyan 2bhk 55L, call karo Mahesh bhai 80000 01988',
    [
      ['NAME', 'Mahesh'],
      ['PHONE', '80000 01988'],
    ],
    ['Kalyan', '2bhk', '55L'],
  ),
  ad(
    'श्री राजेश शिंदे, मो. ९०००००१९९९, ठाणे 2BHK',
    [
      ['NAME', 'राजेश शिंदे'],
      ['PHONE', '९०००००१९९९'],
    ],
    ['ठाणे', '2BHK'],
  ),
  ad(
    'Borivali flat bechna hai 1.1 Cr, Suresh bhau 7000002000',
    [
      ['NAME', 'Suresh'],
      ['PHONE', '7000002000'],
    ],
    ['Borivali', '1.1 Cr'],
  ),
  // --- Chat questions (insight) ---------------------------------------------------------------------------------
  ad(
    'show me 2BHK offers in Powai under 2 Cr that Rakesh Mehta 90000 02011 sent last week',
    [
      ['NAME', 'Rakesh Mehta'],
      ['PHONE', '90000 02011'],
    ],
    ['2BHK', 'Powai', '2 Cr', 'last week'],
  ),
  ad('what did Mr Shah ask about Worli offices?', [['NAME', 'Shah']], ['Worli', 'offices']),
  ad('list demands from Priya Nair in Andheri East', [['NAME', 'Priya Nair']], ['Andheri East']),
  ad('call Sanjay about DEM-000127 and INV-000045', [['NAME', 'Sanjay']], ['DEM-000127', 'INV-000045']),
  ad(
    'who owns flat 1502 in Lodha Park, owner Neha said 9000002022',
    [
      ['UNIT', '1502'],
      ['NAME', 'Neha'],
      ['PHONE', '9000002022'],
    ],
    ['Lodha Park'],
  ),
  ad('find the record with phone 80000 02033', [['PHONE', '80000 02033']], []),
  ad(
    'offers similar to da724e14fa03 posted by Anand Kulkarni',
    [['NAME', 'Anand Kulkarni']],
    ['da724e14fa03'],
  ),
  ad(
    'send the Bhiwandi warehouse list to rohan.fake@example.com',
    [['EMAIL', 'rohan.fake@example.com']],
    ['Bhiwandi'],
  ),
  ad(
    'how many offers did broker Vikram Sethi share in Thane this month?',
    [['NAME', 'Vikram Sethi']],
    ['Thane', 'this month'],
  ),
  ad('contact priya about the 3bhk in bandra', [['NAME', 'priya']], ['3bhk', 'bandra']),
  // --- More supply ads (volume) ---------------------------------------------------------------------------------
  ad(
    'Kurla W 1BHK 70L, 5 min from LBS. Owner Javed Ansari 90000 02044',
    [
      ['NAME', 'Javed Ansari'],
      ['PHONE', '90000 02044'],
    ],
    ['Kurla W', '70L', '5 min', 'LBS'],
  ),
  ad(
    'Byculla 2BHK 1.6 Cr, Flat 1805, Bombay Dyeing ICC. Call Zubin 9000002055',
    [
      ['UNIT', '1805'],
      ['NAME', 'Zubin'],
      ['PHONE', '9000002055'],
    ],
    ['Byculla', '1.6 Cr', 'Bombay Dyeing ICC'],
  ),
  ad(
    'Wadala 3BHK 2.6 Cr, 1150 carpet, 21st floor. Contact Lokesh 80000 02066',
    [
      ['NAME', 'Lokesh'],
      ['PHONE', '80000 02066'],
    ],
    ['Wadala', '2.6 Cr', '1150 carpet', '21st floor'],
  ),
  ad(
    'Matunga E 2BHK old bldg 1.9 Cr, Flat No 6. Mr. Venkatesh 7000002077',
    [
      ['UNIT', 'No 6'],
      ['NAME', 'Venkatesh'],
      ['PHONE', '7000002077'],
    ],
    ['Matunga E', '1.9 Cr'],
  ),
  ad(
    'Prabhadevi 4BHK 9.5 Cr, 2400 sqft, sea view, 40th floor. Contact Ms Tanya 9000002088',
    [
      ['NAME', 'Tanya'],
      ['PHONE', '9000002088'],
    ],
    ['Prabhadevi', '9.5 Cr', '2400 sqft', '40th floor'],
  ),
  ad(
    'Vikhroli E 2BHK Godrej project 1.7 Cr. Contact Ashok Pillai 90000 02099',
    [
      ['NAME', 'Ashok Pillai'],
      ['PHONE', '90000 02099'],
    ],
    ['Vikhroli E', '1.7 Cr'],
  ),
  ad(
    'Bhandup W 1BHK rent 24k, Flat 101. Contact Sagar 8000002100',
    [
      ['UNIT', '101'],
      ['NAME', 'Sagar'],
      ['PHONE', '8000002100'],
    ],
    ['Bhandup W', '24k'],
  ),
  ad(
    'Airoli sector 5 2BHK 1.15 Cr. Contact 70000 02111 Pradeep',
    [
      ['PHONE', '70000 02111'],
      ['NAME', 'Pradeep'],
    ],
    ['Airoli', 'sector 5', '1.15 Cr'],
  ),
  ad(
    'Kopar Khairane 1BHK 58L. Call Nitin Gaikwad on 9000002122.',
    [
      ['NAME', 'Nitin Gaikwad'],
      ['PHONE', '9000002122'],
    ],
    ['Kopar Khairane', '58L'],
  ),
  ad(
    'Seawoods 3BHK rent 65k near NRI complex. Contact Ritu 90000 02133',
    [
      ['NAME', 'Ritu'],
      ['PHONE', '90000 02133'],
    ],
    ['Seawoods', '65k', 'NRI complex'],
  ),
  ad(
    'Belapur CBD office 1000 sqft 1.1 Cr. Contact Omkar 8000002144',
    [
      ['NAME', 'Omkar'],
      ['PHONE', '8000002144'],
    ],
    ['Belapur CBD', '1000 sqft', '1.1 Cr'],
  ),
  ad('Virar W 1BHK 32L, 5 min station. Contact 70000 02155', [['PHONE', '70000 02155']], ['Virar W', '32L']),
  ad(
    'Vasai E industrial gala 1500 sqft rent 45k, Gala No 22. Ph 9000002166',
    [
      ['UNIT', 'No 22'],
      ['PHONE', '9000002166'],
    ],
    ['Vasai E', '1500 sqft', '45k'],
  ),
  ad(
    'Badlapur 1BHK 28L new project. Contact Swapnil 80000 02177',
    [
      ['NAME', 'Swapnil'],
      ['PHONE', '80000 02177'],
    ],
    ['Badlapur', '28L'],
  ),
  ad(
    'Ulhasnagar shop 150 sqft 35L. Contact Kishore 7000002188',
    [
      ['NAME', 'Kishore'],
      ['PHONE', '7000002188'],
    ],
    ['Ulhasnagar', '150 sqft', '35L'],
  ),
  ad('Kalwa 1RK 18L. Contact 9000002199', [['PHONE', '9000002199']], ['Kalwa', '1RK', '18L']),
  ad(
    'Santacruz W 3BHK rent 2.2L, Flat 3A, Sea Breeze. Contact Rhea 90000 02200',
    [
      ['UNIT', '3A'],
      ['NAME', 'Rhea'],
      ['PHONE', '90000 02200'],
    ],
    ['Santacruz W', '2.2L', 'Sea Breeze'],
  ),
  ad(
    'Juhu 2BHK furnished rent 1.8L. Email juhu.flat.fake@example.com, call 8000002211',
    [
      ['EMAIL', 'juhu.flat.fake@example.com'],
      ['PHONE', '8000002211'],
    ],
    ['Juhu', '1.8L'],
  ),
  ad(
    'Oshiwara office 900 sqft, Office No. 510, Crystal Plaza, 95k. Contact 70000 02222',
    [
      ['UNIT', '510'],
      ['PHONE', '70000 02222'],
    ],
    ['Oshiwara', '900 sqft', 'Crystal Plaza', '95k'],
  ),
  ad(
    'Jogeshwari E 2BHK 1.25 Cr. Contact Mr & Mrs Kamath 9000002233',
    [
      ['NAME', 'Kamath'],
      ['PHONE', '9000002233'],
    ],
    ['Jogeshwari E', '1.25 Cr'],
  ),
  ad(
    'Chandivali 2BHK 1.45 Cr, 18th floor. Contact Abhishek 90000-02244 / Megha 90000-02255',
    [
      ['NAME', 'Abhishek'],
      ['PHONE', '90000-02244'],
      ['NAME', 'Megha'],
      ['PHONE', '90000-02255'],
    ],
    ['Chandivali', '1.45 Cr', '18th floor'],
  ),
  ad(
    'Marol 1BHK rent 35k. From Rakhi, 8000002266',
    [
      ['NAME', 'Rakhi'],
      ['PHONE', '8000002266'],
    ],
    ['Marol', '35k'],
  ),
  ad(
    'Sion Koliwada 2BHK 1.1 Cr. Attn: Gurpreet Singh 70000 02277',
    [
      ['NAME', 'Gurpreet Singh'],
      ['PHONE', '70000 02277'],
    ],
    ['Sion Koliwada', '1.1 Cr'],
  ),
  ad(
    'Grant Road 1BHK 95L old bldg. Contact Hussain 9000002288',
    [
      ['NAME', 'Hussain'],
      ['PHONE', '9000002288'],
    ],
    ['Grant Road', '95L'],
  ),
  ad(
    'Mahim 2BHK rent 90k, Flat No. 7, Sea Face. Contact Anthony 90000 02299',
    [
      ['UNIT', 'No. 7'],
      ['NAME', 'Anthony'],
      ['PHONE', '90000 02299'],
    ],
    ['Mahim', '90k', 'Sea Face'],
  ),
  ad(
    'Tardeo office 1500 sqft 4.2 Cr. Contact Shailesh 8000002300',
    [
      ['NAME', 'Shailesh'],
      ['PHONE', '8000002300'],
    ],
    ['Tardeo', '1500 sqft', '4.2 Cr'],
  ),
  ad(
    'Hinjewadi Pune 2BHK 75L. Contact Tejas 7000002311',
    [
      ['NAME', 'Tejas'],
      ['PHONE', '7000002311'],
    ],
    ['Hinjewadi', 'Pune', '75L'],
  ),
  ad(
    'Goa villa Assagao 4BHK 6 Cr. Contact Clara 9000002322',
    [
      ['NAME', 'Clara'],
      ['PHONE', '9000002322'],
    ],
    ['Goa', '4BHK', '6 Cr'],
  ),
  ad(
    'Lokhandwala Complex 3BHK rent 1.1L. Contact Yash 90000 02333',
    [
      ['NAME', 'Yash'],
      ['PHONE', '90000 02333'],
    ],
    ['Lokhandwala Complex', '1.1L'],
  ),
  ad(
    'Gorai 2BHK 90L sea view. Contact Pinto 8000002344',
    [
      ['NAME', 'Pinto'],
      ['PHONE', '8000002344'],
    ],
    ['Gorai', '90L'],
  ),
  ad(
    'Ghodbunder Road 3BHK 1.6 Cr, Tower B-1904. Contact Vaibhav 70000 02355',
    [
      ['UNIT', 'B-1904'],
      ['NAME', 'Vaibhav'],
      ['PHONE', '70000 02355'],
    ],
    ['Ghodbunder Road', '1.6 Cr'],
  ),
  ad(
    'Powai 2BHK rent 60k, Flat D 803, Avalon. Call 9000002366 (Kunal)',
    [
      ['UNIT', 'D 803'],
      ['PHONE', '9000002366'],
      ['NAME', 'Kunal'],
    ],
    ['Powai', '60k', 'Avalon'],
  ),
  ad(
    'Sale: 2BHK, Chembur, Rs 1.4 Cr — contact: jatin.fake@example.com — 90000 02377 — Jatin',
    [
      ['EMAIL', 'jatin.fake@example.com'],
      ['PHONE', '90000 02377'],
      ['NAME', 'Jatin'],
    ],
    ['2BHK', 'Chembur', '1.4 Cr'],
  ),
  ad(
    'Contact person: Ms. Lata Menon, Ph: 022-2000 2388',
    [
      ['NAME', 'Lata Menon'],
      ['PHONE', '022-2000 2388'],
    ],
    [],
  ),
  ad(
    'Rent 1BHK Kandivali 26k. Call 60000 02399 Sonal',
    [
      ['PHONE', '60000 02399'],
      ['NAME', 'Sonal'],
    ],
    ['1BHK', 'Kandivali', '26k'],
  ),
  ad(
    'Bandra Kurla Complex office 10,000 sqft, 18L pm, Unit 601-602. Contact Aditya 9000002400',
    [
      ['UNIT', '601-602'],
      ['NAME', 'Aditya'],
      ['PHONE', '9000002400'],
    ],
    ['Bandra Kurla Complex', '10,000 sqft', '18L pm'],
  ),
  ad('Dahisar E 2BHK 1.05 Cr. Ph. 9000 0024 11', [['PHONE', '9000 0024 11']], ['Dahisar E', '1.05 Cr']),
  ad(
    'Karjat farm plot 10 guntha 18L. Contact Dnyaneshwar 8000002422',
    [
      ['NAME', 'Dnyaneshwar'],
      ['PHONE', '8000002422'],
    ],
    ['Karjat', '10 guntha', '18L'],
  ),
  ad(
    'Neral 1BHK 22L. Call 7000002433 Manisha',
    [
      ['PHONE', '7000002433'],
      ['NAME', 'Manisha'],
    ],
    ['Neral', '1BHK', '22L'],
  ),
  ad(
    'Aadhaar 3456-7890-1234 of the tenant received, Chembur 1BHK',
    [['ID', '3456-7890-1234']],
    ['Chembur', '1BHK'],
  ),
  ad('GSTIN 27ABCPE1234F1Z5 of the lessee, office at Thane', [['ID', '27ABCPE1234F1Z5']], ['Thane']),
  ad(
    'Contact Mr. S. V. Joshi 90000 02466 for Dadar flat',
    [
      ['NAME', 'S. V. Joshi'],
      ['PHONE', '90000 02466'],
    ],
    ['Dadar'],
  ),
  ad(
    'Price 1.25 Cr. Call 90000 02477.Sanjay',
    [
      ['PHONE', '90000 02477'],
      ['NAME', 'Sanjay'],
    ],
    ['1.25 Cr'],
  ),
  ad(
    'Flat no:- 1604, Malad W. 90000 02488 - Rakesh (Broker)',
    [
      ['UNIT', '1604'],
      ['PHONE', '90000 02488'],
      ['NAME', 'Rakesh'],
    ],
    ['Malad W'],
  ),
  ad(
    'Tel 022-2000 2499/35/36, Nariman Point office',
    [
      ['PHONE', '022-2000 2499'],
      ['PHONE', '/35/36'],
    ],
    ['Nariman Point'],
  ),
  ad(
    'Contact Sanjay Mehta (Owner) 90000 02500',
    [
      ['NAME', 'Sanjay Mehta'],
      ['PHONE', '90000 02500'],
    ],
    ['(Owner)'],
  ),
  ad(
    'Mazgaon 2BHK 2.1 Cr, Flat No. 1401, B Wing. Contact 022 2000 2444 / 90000 02455',
    [
      ['UNIT', '1401'],
      ['UNIT', 'B Wing'],
      ['PHONE', '022 2000 2444'],
      ['PHONE', '90000 02455'],
    ],
    ['Mazgaon', '2.1 Cr'],
  ),
];

/** Texts with no personal data: every one must come back unchanged. */
export const CLEAN_ADS: readonly string[] = [
  'Sale: 2BHK Andheri East, 750 sq ft carpet, 12th floor, Rs 1.25 Cr, RERA P51800012345, possession Dec 2026',
  'Industrial land 4 acres at Bhiwandi, Rs 18 Cr, NA plot, near Mumbai-Nashik highway',
  'Area 2500-3000 sqft required in BKC, budget 4-5L pm',
  'Pincode 400069, Andheri East, 3 BHK 1250 sq ft, 15th floor of 22',
  'Possession 31.12.2026, price 2,25,00,000 all inclusive',
  'Rate Rs 25,000 per sqft, 1100-1300 sqft, 2024-2025 completion',
  'Office hours 10.30-6.30, Mon to Sat',
  'G+14 tower, 2 wings, 4 flats per floor, 3 lifts',
  'Shop 200 sq ft on main road Dadar W, rent 80k',
  'Plot 5000 sqft in MIDC Taloja',
  'Flat 2 BHK for rent in Powai, 55k',
  'Grade A office, 25,000 sqft, floor plate 12,500 sqft, Worli',
  'Lower Parel 1.5 Cr to 2 Cr, 3 min walk from station',
  'Budget 90L-1.2 Cr, 2BHK Chembur/Ghatkopar',
  'NH 48 frontage land 2 acres, NH-4 access',
  'Mumbai Pune Expressway, 10 guntha, Rs 45 lakh per guntha',
  'record da724e14fa03 and parent a0d22fc061a8 are repeats',
  'DEM-000127 matched INV-000045 at 92%',
  'Year built 2015, 7 yrs old, OC received',
  'Sanpada sector 17, 1BHK 650 sqft, 72 lakh',
  'Wanted: office 1000-1500 sqft in Andheri, budget Rs 1,20,000 pm',
  'Office 2000 sq ft on 5th floor, Nariman Point, 3.5L pm',
  'Hiranandani Estate Thane 2BHK 1.35 Cr, ready possession',
  'Kalpataru Radiance Goregaon W 3BHK 3.1 Cr, 1300 carpet',
  'Sale 3 flats in same building, 1 Cr each, Vile Parle E',
  'Price Rs 1.1 Cr (negotiable), 900 sqft, 7th floor',
  'Available from 01/11/2026, 2BHK Kharghar sector 20',
  'MahaRERA registered project P51700045678, Thane W, 2 & 3 BHK',
  'Land 2.5 acres, rate Rs 3,500 per sq ft, Palghar',
  'Office 1200 sqft, rent Rs 1,50,000 per month, Andheri E',
  'Sale price Rs. 12500000/- for 1BHK in Borivali',
  '3 BHK + study, 1650 sqft, 2 car parks, Bandra W',
  'Rent 65k, deposit 3L, 2BHK Chembur near Diamond Garden',
  'Commercial space 4000 sqft ground + 1 at Thane Station road',
  'Brokers excuse. Owner direct. No brokerage.',
  'show offers in Powai between 1 and 2 Cr sorted by price',
  'how many demands came from Times of India this week?',
  'list 2BHK offers in Andheri West above 20th floor',
  'Ready to move, OC received, 2 lifts, 24x7 security, Malad W',
  'Sq ft rate 18,000-22,000 in Worli, 2026 launch',
  'Call for site visit, Sunday open house, Thane W 2BHK',
  'Contact for details: 3BHK Powai, 2.5 Cr',
  'From Andheri Station 5 mins, 1BHK 75L',
  'Owner Direct, No Brokerage, Chembur 2BHK',
  'CALL NOW FOR BEST DEALS IN KHARGHAR',
  'Contact Sales Office at Hiranandani Estate',
  'Speak to our Relationship Manager for home loans',
  'Posted by Owner, Andheri E',
  'Enquiry for Lodha Palava 2BHK, 65L onwards',
  'Tower 2 of 4, 38 floors, 4 flats per floor, possession 2028',
];
