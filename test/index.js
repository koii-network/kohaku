const swicw = require("..");
const Arweave = require("arweave");
const smartweave = require("smartweave");

// 9BX6HQV5qkGiXV6hTglAuPdccKoEP_XI2NNbjHv5MMM main contract
// 0Z4z_Z6tLza640a9aB6Y4wsUHO80i2JAgOa5rZZ7TsA new task contract
const CONTRACT_ID = "IpEKWpnCCa09-fALeXsQmVD_UYHCuyblVpgPOrsMXEM"; // old task contract

async function main() {
  const arweave = Arweave.init({
    host: "arweave.net",
    port: 443,
    protocol: "https",
    logging: false,
    timeout: 60000
  });

  // console.log("Reading recursive contract with smartweave");
  // const t1 = new Date();
  // const res1 = await smartweave.readContract(arweave, CONTRACT_ID);
  const t2 = new Date();
  // console.log(`Done in ${t2 - t1}\n\nReading recursive contract with swicw`);

  const res2 = await swicw.readContract(arweave, CONTRACT_ID);
  const t3 = new Date();
  console.log(
    `Done in ${
      t3 - t2
    }\n\nRereading recursive contract with swicw (should now be cached)`
  );

  const res3 = await swicw.readContract(arweave, CONTRACT_ID);
  const t4 = new Date();
  console.log(`Done in ${t4 - t3}`);

  console.log(
    "\nswicw matches SmartWeave?",
    JSON.stringify(res1) === JSON.stringify(res2)
  );
}

main().then(() => console.log("Terminated"));
