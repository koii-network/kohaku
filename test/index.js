const kohaku = require("..");
const Arweave = require("arweave");
const smartweave = require("smartweave");

// 9BX6HQV5qkGiXV6hTglAuPdccKoEP_XI2NNbjHv5MMM main contract
// 0Z4z_Z6tLza640a9aB6Y4wsUHO80i2JAgOa5rZZ7TsA new task contract
// IpEKWpnCCa09-fALeXsQmVD_UYHCuyblVpgPOrsMXEM old task contract
const CONTRACT_ID = "b8y_FD82vSaE1skZtqPqtz9q6xiuZnqRcCm9mV90SuY";
const NONREC_CONTRACT_ID = "qUUBzVLsdu0S_6nFu7jMmE1SU6elIW44quH6dXgY6BE";

async function main() {
  const arweave = Arweave.init({
    host: "arweave.net",
    port: 443,
    protocol: "https",
    logging: false,
    timeout: 60000
  });

  console.log("Reading recursive contract with SmartWeave");
  const t1 = new Date();
  const res1 = await smartweave.readContract(arweave, CONTRACT_ID);
  const t2 = new Date();
  console.log(`Done in ${t2 - t1}ms\n\nReading recursive contract with Kohaku`);

  const res2 = await kohaku.readContract(arweave, CONTRACT_ID);
  const t3 = new Date();
  console.log(
    `Done in ${
      t3 - t2
    }ms\n\nRereading recursive contract with Kohaku (should now be cached)`
  );

  const res3 = await kohaku.readContract(arweave, CONTRACT_ID);
  const t4 = new Date();
  console.log(`Done in ${t4 - t3}ms`);

  const swState = JSON.stringify(res1);
  console.log(
    "\nKohaku matches SmartWeave for recursive contract?",
    JSON.stringify(res2) === swState,
    JSON.stringify(res3) === swState
  );

  console.log("\nReading non-recursive contract with SmartWeave");
  const res4 = await smartweave.readContract(arweave, NONREC_CONTRACT_ID);
  const t5 = new Date();
  console.log(
    `Done in ${t5 - t4}ms\n\nReading non-recursive contract with Kohaku`
  );

  const res5 = await kohaku.readContract(arweave, NONREC_CONTRACT_ID);
  const t6 = new Date();
  console.log(`Done in ${t6 - t5}ms`);

  console.log(
    "\nKohaku matches SmartWeave for non-recursive contract?",
    JSON.stringify(res4) === JSON.stringify(res5)
  );

  console.log("\nExporting Kohaku cache");
  console.time("export");
  const exp = kohaku.exportCache();
  console.timeEnd("export");

  console.log("Importing kohaku cache");
  console.time("import");
  await kohaku.importCache(arweave, exp);
  console.timeEnd("import");

  console.log("Verifying import integrity");
  const res6 = await kohaku.readContract(arweave, CONTRACT_ID);
  console.log(
    "Imported Kohaku read matches SmartWeave?",
    swState == JSON.stringify(res6)
  );
}

(async () => await main())();
