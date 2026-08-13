// api/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";

const app = express();
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.MAINNET_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("❌ Faltan variables de entorno. Revisa MAINNET_RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS");
  // En serverless no llamamos a process.exit, lanzamos error para que Vercel lo muestre
  throw new Error("Faltan variables de entorno");
}

const DONATION_WALLET_ABI = [
  "function usdcToken() view returns (address)",
  "function owner() view returns (address)",
  "function getBalance() view returns (uint256)",
  "function calculateDonation(address donor) view returns (uint256)",
  "function getDonorStats(address donor) view returns (uint256 total, uint256 count)",
  "function processDonation(address donor, uint256 amount, uint256 donorBalance, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (bool)",
  "function withdrawDonations(address to, uint256 amount)",
  "event DonationReceived(address indexed donor, uint256 amount, uint256 percentage, uint256 donorBalance, uint256 timestamp)",
  "event DonationFailed(address indexed donor, bytes32 indexed nonce, string reason)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, DONATION_WALLET_ABI, ownerWallet);

let usdcContract;

async function getUsdcContract() {
  if (!usdcContract) {
    const usdcAddress = await contract.usdcToken();
    usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  }
  return usdcContract;
}

// ---------- RUTA RAÍZ ----------
app.get("/", (req, res) => {
  res.send("🚀 Backend funcionando correctamente");
});

// ---------- RUTAS API ----------
app.get("/api/info", async (req, res) => {
  try {
    const [usdcAddress, owner, contractBalance, network] = await Promise.all([
      contract.usdcToken(),
      contract.owner(),
      contract.getBalance(),
      provider.getNetwork(),
    ]);
    res.json({
      contractAddress: CONTRACT_ADDRESS,
      usdcAddress,
      owner,
      contractBalanceUsdc: ethers.formatUnits(contractBalance, 6),
      chainId: network.chainId.toString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/balance/:address", async (req, res) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: "Dirección inválida" });
    }
    const usdc = await getUsdcContract();
    const balance = await usdc.balanceOf(address);

    let donation = 0n;
    let donationError = null;
    try {
      donation = await contract.calculateDonation(address);
    } catch {
      donationError = "Balance insuficiente para el mínimo de donación (0.1 USDC)";
    }

    res.json({
      address,
      balance: balance.toString(),
      balanceFormatted: ethers.formatUnits(balance, 6),
      donationAmount: donation.toString(),
      donationFormatted: ethers.formatUnits(donation, 6),
      donationError,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/donate", async (req, res) => {
  try {
    const { donor, amount, donorBalance, validAfter, validBefore, nonce, v, r, s } = req.body;

    if (
      !donor || !amount || !donorBalance ||
      validAfter === undefined || !validBefore ||
      !nonce || v === undefined || !r || !s
    ) {
      return res.status(400).json({ error: "Faltan campos requeridos en la solicitud" });
    }

    console.log(`📥 Procesando donación de ${donor}...`);

    const tx = await contract.processDonation(
      donor,
      amount,
      donorBalance,
      validAfter,
      validBefore,
      nonce,
      v,
      r,
      s
    );

    console.log("⏳ Tx enviada:", tx.hash);
    const receipt = await tx.wait();

    const donationReceived = receipt.logs.some((log) => {
      try {
        const parsed = contract.interface.parseLog(log);
        return parsed?.name === "DonationReceived";
      } catch {
        return false;
      }
    });

    console.log(donationReceived ? "✅ Donación exitosa" : "⚠️ Donación registrada como fallida");

    res.json({
      success: donationReceived,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      explorerUrl: `https://etherscan.io/tx/${tx.hash}`,
    });
  } catch (err) {
    console.error("❌ Error procesando donación:", err);
    res.status(500).json({ error: err.reason || err.message });
  }
});

app.get("/api/donor/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const [total, count] = await contract.getDonorStats(address);
    res.json({
      address,
      totalDonated: ethers.formatUnits(total, 6),
      donationCount: count.toString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- MANEJADOR DE RUTAS NO ENCONTRADAS (opcional) ----------
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// ---------- EXPORTACIÓN PARA VERCEL (serverless) ----------
export default app;
