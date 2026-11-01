// Wire model value (app number - 1) -> name, per module type. Data from the upstream repo's catalog.

const list = (s: string): Record<number, string> =>
  Object.fromEntries(s.split("|").map((name, i) => [i, name]));

export const MODEL_NAMES: Record<number, Record<number, string>> = {
  // Drive
  0x01: list("Pure Boost|Flex Boost|Tube DR|808|Gold Clon|D-Drive|Jimmy OD|Full DR|Beebee Pre|Beebee+|Black Rat|Grey Faze|Muffy|Full DS|Shred|Riet|MTL Zone|MTL Master|Obsessive Dist|Rumble Drive|Solo|Blues Mood|Blues Crab|Blade|TS9 Boost|ROD881|Tethys 21|TS Drive|Blackglass X8"),
  // Pre-Amp
  0x02: list("65 US DLX|65 US TW|59 US Bass|US Sonic|US Blues CL|US Blues OD|E650 CL|Powerbell CL|Blacknight CL|Mark III CL|Mark V CL|Tri Rec CL|Rockvrb CL|Dr Zee 18 JR|Dr Zee Reck|Jet 100H CL|Jazz 120|UK 30 CL|UK 30 OD|HWT 103|PV5050 CL|Regal Tone CL|Regal Tone OD1|Carol CL|Cardeff|EV 5050 CL|HT Club CL|Hugen CL|Koche OD|J800|J900|PLX 100|E650 DS|Powerbell DS|Blacknight DS|Mark III DS|Mark V DS|Tri Rec DS|Rockvrb DS|Citrus 30|Citrus 50|Slow 100 CR|Slow 100 DS|Jet 100H OD|PV 5050 DS|Regal Tone OD2|Carol OD|EV 5050 DS|HT Club DS|Hugen OD|Hugen DS|Koche DS|AMPOG 2OD|AMPOG B18 CL|AMPOG SVT 4|AMPOG SVT VALVE|MVRKBASS 500|MVRKBASS 501|AKUILA 750 CL|AKUILA 750 DS|AKUILA 751|Basser Crunch"),
  // Cab
  0x03: list("Regal Tone 110|US DLX 112|Sonic 112|Blues 112|Mark 112|Dr Zee 112|Cardeff 112|US TW 212|Citrus 212|Dr Zee 212|Jazz 212|UK 212|Tow Stones 212|US Bass 410|1960 412|Eagle P412|Eagle S412|Rec 412|Citrus 412|Slow 412|HWT 412|PV 5050 412|EV 5050 412|HT 412|Diesel 412|CT-SupBMK112|CT-FendS212|CT-FendTW212|CT-Fend67212|CT-BritJV212|CT-Brit412|CT-BritJ412|CT-Bogie212|CT-BogieLS212|CT-BogOS412|CT-Vocs212|CT-Barb212|CT-Fram212|CT-Kox212|CT-Mgan212|CT-Edd412|CT-Fried412|CT-Gas412|CT-Hess212|CT-Hess412|CT-HW412|CT-HK412|CT-OR412|CT-Pvyln212|CT-Pvy50412|CT-Revo412|CT-River412|CT-Sold412|CT-VTH412|CT-Win412|SV810 U47|SV810 121|SV810 7B|HK U47|HK 7B|HK 121|HK 421|Akuila U47|Akuila 7B|Akuila 121"),
  // Dyna
  0x04: list("Red Comp|Yellow Comp|Noise Killer|Intel Reducer"),
  // Filter
  0x05: list("Touch Wah|Auto Wah|Q-Filter"),
  // Mod
  0x06: list("Phaser|Step Phaser|Flanger|Jet Flanger|Tremolo|Stutter|Vibrato|Rotary|Ring|Pitch Shift|Ana Chorus|Tri Chorus|Lofi|Slow Gear"),
  // Delay
  0x07: list("Digital|Analog|Real Echo|Tape|Mod|Reverse|PingPong|Crystal|Rainbow"),
  // Reverb
  0x08: list("Room|Hall|Plate|Spring|Mod|Shimmer"),
  // EQ
  0x09: list("5 Bands EQ|Custom EQ"),
  // Guitar Sim
  0x0a: list("Ac Electric GBS 45 a|Ac Electric GBS 45 b|Ac Electric GBS 45 c|Ac Electric GBS SJ200 a|Ac Electric GBS SJ200 b|Ac Electric GBS SJ200 c|Ac Electric GLD D55 a|Ac Electric GLD D55 b|Ac Electric GLD D55 c|Ac Electric MTN D45 a|Ac Electric MTN D45 b|Ac Electric MTN D45 c|Ac Electric TLR 614a|Ac Electric TLR 614b|Ac Electric TLR 614c|Ac Piezo GBS 45 a|Ac Piezo GBS 45 b|Ac Piezo GBS 45 c|Ac Piezo GBS SJ200 a|Ac Piezo GBS SJ200 b|Ac Piezo GBS SJ200 c|Ac Piezo GLD D55 a|Ac Piezo GLD D55 b|Ac Piezo GLD D55 c|Ac Piezo MTN D45 a|Ac Piezo MTN D45 b|Ac Piezo MTN D45 c|Ac Piezo TLR 614a|Ac Piezo TLR 614b|Ac Piezo TLR 614c|Ac Silent GBS 45 a|Ac Silent GBS 45 b|Ac Silent GBS 45 c|Ac Silent GBS SJ200 a|Ac Silent GBS SJ200 b|Ac Silent GBS SJ200 c|Ac Silent GLD D55 a|Ac Silent GLD D55 b|Ac Silent GLD D55 c|Ac Silent MTN D45 a|Ac Silent MTN D45 b|Ac Silent MTN D45 c|Ac Silent TLR 614a|Ac Silent TLR 614b|Ac Silent TLR 614c|Cl Piezo Corba GK a|Cl Piezo Corba GK b|Cl Piezo Corba GK c|Cl Piezo YMH 42S a|Cl Piezo YMH 42S b|Cl Piezo YMH 42S c|Cl Silent Corba GK a|Cl Silent Corba GK b|Cl Silent Corba GK c|Cl Silent YMH 42S a|Cl Silent YMH 42S b|Cl Silent YMH 42S c"),
  // Entire Amp
  0x0b: list("55 US TD|59 US Bass|UK30 CL|UK30 CR|UK30 DS|ODS 100 CL|ODS 100 CR|ODS 100 DS|Dividers CL|Dividers DS|CAA OD100 CH1|CAA OD100 CH2|CAA OD100 CH3|Rock Vrb CL|Rock Vrb DS|J800 CL|J800 CR|J800 DS|PLX 100 CL|PLX 100 DS|EV 5050 CH1|EV 5050 CH2|EV 5050 CH3|Cali BLD CL|Cali BLD CR|Cali BLD DS"),
};

/** Models 200...209 are the ten user slots of the Samples tab (Drive, Pre-Amp, Cab, Entire Amp). Seen on a pedal:
 *  slot 1 of the Pre-Amp and of the Cab; the other slots and types follow the same pattern. */
export const USER_MODEL_BASE = 200;
for (const type of [0x01, 0x02, 0x03, 0x0b]) {
  for (let slot = 1; slot <= 10; slot++) MODEL_NAMES[type][USER_MODEL_BASE + slot - 1] = `User ${slot}`;
}
