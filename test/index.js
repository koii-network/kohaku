const smartweave = require("..");
const Arweave = require("arweave");

async function main() {
  const arweave = Arweave.init({
    host: "arweave.net",
    port: 443,
    protocol: "https",
    logging: false
  });

  console.log("Reading contract");
  const t1 = new Date();
  const res = await smartweave.readContract(
    arweave,
    "cETTyJQYxJLVQ6nC3VxzsZf1x2-6TW2LFkGZa91gUWc"
  );
  const t2 = new Date();
  console.log(`Done in ${t2 - t1}, rereading (should be cached)`);
  const res2 = await smartweave.readContract(
    arweave,
    "cETTyJQYxJLVQ6nC3VxzsZf1x2-6TW2LFkGZa91gUWc"
  );
  const t3 = new Date();
  console.log(`Done in ${t3 - t2}`);
}

main().then(() => console.log("Terminated"));
