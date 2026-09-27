/**
 * Word lists used by the name detector. A capitalised word next to a contact phrase is treated as a person name
 * unless it is listed here. Everything is lower case; lookups lower-case the token first.
 *
 * Add a word here when a test shows it being masked as a NAME by mistake (see README "Adding patterns").
 */

/** Mumbai Metropolitan Region and nearby localities, micromarkets, landmarks and cities seen in ads. */
const PLACES = `
mumbai bombay thane navi pune nashik nagpur goa karjat khopoli lonavala alibaug panvel kalyan dombivli bhiwandi
ulhasnagar ambernath badlapur titwala vasai virar nalasopara palghar boisar dahanu shahapur murbad neral uran
andheri bandra khar santacruz santa cruz vile parle juhu versova lokhandwala oshiwara jogeshwari goregaon malad kandivali
borivali dahisar mira bhayander bhayandar kurla ghatkopar vikhroli kanjurmarg bhandup mulund powai chandivali saki naka
sakinaka marol chakala seepz midc chembur govandi mankhurd deonar wadala sion matunga dadar mahim prabhadevi worli lower
parel upper lalbaug byculla mazgaon colaba cuffe parade fort churchgate nariman point marine lines charni 
tardeo breach candy peddar cumballa hill malabar walkeshwar napean sea girgaon kalbadevi masjid bunder dongri
bhuleshwar opera house kemps corner haji ali mahalaxmi agripada nagpada mumbai central bkc kalina vakola kherwadi
kalanagar pali naka linking hill waterfield bandstand gorai manori madh marve aksa erangal
charkop poisar akurli village gokuldham film city aarey dindoshi kurar pathanwadi evershine park
antop nagar pestom vidyavihar vihar rajawadi pant kamothe kharghar belapur cbd nerul seawoods vashi
sanpada turbhe koparkhairane kopar khairane ghansoli airoli rabale mahape ulwe dronagiri taloja kalamboli roadpali
khandeshwar ghodbunder hiranandani estate kolshet majiwada manpada kasarvadavali waghbil kapurbawdi vartak nagar
naupada panchpakhadi wagle kalwa mumbra diva shil phata dahisar lodha palava kasheli anjur khoni kalher 
lonad padgha sonale vadpe pimplas saravali mankoli dapode kalher vashere gundavali chimbipada ambadi wada
hinjewadi baner aundh wakad kharadi viman magarpatta hadapsar kothrud koregaon chakan talegaon ranjangaon
gujarat ahmedabad surat vapi silvassa daman valsad bharuch vadodara rajasthan delhi noida gurgaon gurugram bangalore
bengaluru hyderabad chennai kolkata maharashtra india konkan ratnagiri raigad sindhudurg dapoli murud kashid
mahabaleshwar panchgani lavasa satara kolhapur sangli aurangabad west east north south central city town
`;

/** Real-estate and ad vocabulary. */
const PROPERTY = `
flat flats apartment apartments apt bhk rk room rooms hall kitchen bed bath bathroom toilet balcony terrace deck
sqft sq ft feet carpet builtup built up super saleable usable area plot plots land acre acres guntha gunta bigha
hectare sq yd yards meter mtr bungalow villa rowhouse row house penthouse duplex studio shop shops showroom office
offices premises space commercial residential industrial warehouse godown gala galas shed factory unit units
building bldg tower towers wing wings floor floors storey storeys ground podium stilt basement mezzanine lift
parking car covered open society chs co-op coop complex heights height apartments residency residence enclave
park garden gardens plaza mall arcade centre center chambers house bhavan bhawan niwas nivas sadan kunj villa
villas nagar colony estate estates road rd marg lane gali cross main highway expressway express western eastern
freeway link bridge flyover station railway metro airport bus depot market chowk circle junction naka signal
school college hospital temple church mosque masjid lake beach sea view facing garden pool gym clubhouse
amenities amenity security intercom power backup water supply oc cc rera maharera registered approved title clear
clean ready possession under construction uc redevelopment redevelop new resale sale rent lease leave license
licence pagdi pagri outright ownership freehold leasehold jv joint venture development tdr fsi far bmc cidco mhada
sra slum layout na agricultural agri zone zoned residential commercial industrial mixed use it ites bpo corporate
furnished unfurnished semi fully bare shell warm fitout fit out interiors modular ac acs cabin cabins workstation
workstations seats seater conference pantry reception washroom washrooms deposit maintenance brokerage
tenant tenanted vacant occupied preleased pre leased leased rental yield returns roi investment investor
price rate rates cost lakh lakhs lac lacs crore crores cr l k rs inr neg negotiable fixed final all inclusive
only just onwards approx approximately per month pm pa annum year years yrs old new brand fresh prime posh
premium luxury luxurious spacious lavish best good nice excellent superb huge big small compact prime corner
direct owner owners broker brokers agent agents dealer dealers consultant consultants builder builders developer
developers promoter excuse excused welcome allowed required requirement wanted want wants need needs looking
available avail immediate immediately urgent urgently sell selling buy buying purchase purchasing rent renting
let letting investor investors nri nris family families bachelors bachelor company companies corporate guest
contact call ph phone mob mobile tel telephone cell whatsapp wa sms msg message email mail visit site details
detail info inquiry enquiry enquiries interested parties party please pls plz kindly also etc near nr opp opposite
behind next adjacent walking distance min mins minute minutes km kms from to at in on of for with without and or
the a an is are be this that these those our your their its it we you they he she him her them us me my
no not yes any all each every some more most less other others same such than then there here where when what
which who whom whose why how new old
`;

/** Common English and Hinglish words that follow contact phrases in ads ("call now", "contact immediately"). */
const COMMON = `
now today tomorrow tonight morning evening afternoon night day days daily weekly monthly time times anytime
between after before during till until upto up down over under above below within across around about
immediately soon asap early late quick quickly fast only just also too very much many few several
free paid sure fine ok okay done hurry limited offer offers deal deals scheme schemes booking bookings book
office hours timing timings working holiday sunday monday tuesday wednesday thursday friday saturday sun mon tue
tues wed thu thur thurs fri sat january february march april may june july august september october november
december jan feb mar apr jun jul aug sep sept oct nov dec us me him her them self yourself
sir madam mam maam team desk sales marketing manager executive office admin reception helpline hotline toll
number numbers no nos landline mobile residence res home work direct personal
mr mrs ms miss dr shri shree smt sri kum km
karo kare karein kijiye kijie kara kar karna sampark samparka sampark sadhaa sadha sanvad bolo baat milo
ke ki ka ko se par mein me hai hain ho hoga liye aur ya bhi jaldi abhi turant sirf
pvt private ltd limited llp inc co corp corporation group associates associate realty realtors realtor
properties property estates estate enterprises enterprise infra infrastructure constructions construction
developers builders homes housing ventures holdings finance financial bank banks capital services service
solutions consultancy consultants agency agencies traders trading industries industry exports imports
international global india indian national mumbai
auction auctions tender tenders notice notices public sarfaesi possession symbolic physical reserve emd bid bids
bidder bidders authorised authorized officer officers branch
said says told sent shared gave has have had asked called wants wanted got get
times mirror economic standard hindu journal midday mid-day samachar express loksatta lokmat
lbs weh sv jvlr ltt cst csmt mg ecc ttc nh sh
person persons aadhaar aadhar pan gst gstin account acct a/c ifsc relationship details site visit house
`;

/** Words that mark the preceding capitalised words as a building, company or place, not a person. */
const TRAILING_NON_PERSON = `
chs society soc tower towers heights height apartment apartments apts residency residences residence enclave
park garden gardens plaza mall arcade centre center chambers complex house bhavan bhawan niwas nivas sadan kunj
villa villas nagar colony estate estates road rd marg lane gali chowk circle station hospital school college
temple church mosque masjid building bldg bldgs palace court mansion manor castle point square bazar bazaar
market industrial ind compound premises hub tech techpark it
realty realtors properties property enterprises infra constructions developers builders homes housing ventures
holdings finance bank capital services solutions consultancy consultants agency associates group pvt private ltd
limited llp inc corp corporation co company industries traders trading
`;

function toSet(...lists: string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const list of lists) {
    for (const w of list.split(/\s+/u)) {
      if (w.length > 0) out.add(w.toLowerCase());
    }
  }
  return out;
}

/** Words that are never a person name. */
export const NON_NAME_WORDS: ReadonlySet<string> = toSet(PLACES, PROPERTY, COMMON);

/** A capitalised run followed by one of these is a building/company/place, not a person. */
export const NON_PERSON_SUFFIXES: ReadonlySet<string> = toSet(TRAILING_NON_PERSON);
