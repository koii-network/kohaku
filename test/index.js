const swicw = require("..");
const Arweave = require("arweave");
const smartweave = require("smartweave");

// 9BX6HQV5qkGiXV6hTglAuPdccKoEP_XI2NNbjHv5MMM main contract
// 0Z4z_Z6tLza640a9aB6Y4wsUHO80i2JAgOa5rZZ7TsA new task contract
// IpEKWpnCCa09-fALeXsQmVD_UYHCuyblVpgPOrsMXEM old task contract
const CONTRACT_ID = "b8y_FD82vSaE1skZtqPqtz9q6xiuZnqRcCm9mV90SuY";

async function main() {
  const arweave = Arweave.init({
    host: "arweave.net",
    port: 443,
    protocol: "https",
    logging: false,
    timeout: 60000
  });

  const height = (await arweave.network.getInfo()).height;

  console.log("Reading recursive contract with SmartWeave");
  const t1 = new Date();
  const res1 = await smartweave.readContract(arweave, CONTRACT_ID, height);
  const t2 = new Date();
  console.log(`Done in ${t2 - t1}ms\n\nReading recursive contract with SWICW`);

  const res2 = await swicw.readContract(arweave, CONTRACT_ID, height);
  const t3 = new Date();
  console.log(
    `Done in ${
      t3 - t2
    }ms\n\nRereading recursive contract with SWICW (should now be cached)`
  );

  const res3 = await swicw.readContract(arweave, CONTRACT_ID, height);
  const t4 = new Date();
  console.log(`Done in ${t4 - t3}ms`);

  console.log(
    "\nSWICW matches SmartWeave?",
    JSON.stringify(res1) === JSON.stringify(res2)
  );
}

(async () => await main())();
