// ngrok-start.js - Nazar ko internet pe live karne ke liye
const ngrok = require('@ngrok/ngrok');

const AUTHTOKEN = '3L39a0G8N6TA2KmHbv00Pdn5rZ7_5R4QGbEpfKZ7EUWigASMh';
const PORT = 3300;

async function startTunnel() {
  console.log('');
  console.log('================================================');
  console.log('   NAZAR - Internet Live via Ngrok');
  console.log('================================================');
  console.log('');
  console.log('>> Ngrok tunnel shuru ho raha hai...');

  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: AUTHTOKEN,
    });

    const url = listener.url();
    console.log('');
    console.log('✅ SUCCESS! Aapki public link:');
    console.log('');
    console.log('   ' + url);
    console.log('');
    console.log('👆 Ye link KISI BHI DEVICE pe, KAHI SE BHI open kar sakte hain!');
    console.log('');
    console.log('------------------------------------------------');
    console.log('NOTE: Jab tak ye window khuli hai, link active rahegi.');
    console.log('Band karne ke liye: Ctrl+C');
    console.log('------------------------------------------------');

    // ✅ Keep process alive - tunnel chalti rahe
    process.stdin.resume();

    // Handle Ctrl+C gracefully
    process.on('SIGINT', async () => {
      console.log('\n\nTunnel band ho rahi hai...');
      await ngrok.disconnect();
      process.exit(0);
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

startTunnel();
