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

// Verificar variables de entorno y guardar estado
let isConfigured = true;
if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("❌ Faltan variables de entorno");
  isConfigured = false;
}

// Si no está configurado, devolvemos error en todas las rutas
app.use((req, res, next) => {
  if (!isConfigured) {
    return res.status(500).json({ error: "Backend no configurado: faltan variables de entorno" });
  }
  next();
});

// ABI del contrato (alineado con el contrato DonationWallet.sol real)
const DONATION_WALLET_ABI = [
  "function usdcToken() view returns (address)",
  "function owner() view returns (address)",
  "function getContractBalance() view returns (uint256)",
  "function getDonorBalance(address donor) view returns (uint256)",
  "function calculateRequiredDonation(address donor) view returns (uint256)",
  "function getDonorStats(address donor) view returns (uint256 total, uint256 count)",
  "function processDonation(address donor, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (bool)",
  "function withdrawDonations(address to, uint256 amount)",
  "function withdrawAll()",
  "event DonationReceived(address indexed donor, uint256 amount, uint256 donorBalanceAfter, uint256 timestamp)",
  "event DonationFailed(address indexed donor, bytes32 indexed nonce, string reason)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

let provider, ownerWallet, contract, usdcContract;

try {
  provider = new ethers.JsonRpcProvider(RPC_URL);
  ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);
  contract = new ethers.Contract(CONTRACT_ADDRESS, DONATION_WALLET_ABI, ownerWallet);
} catch (err) {
  console.error("❌ Error inicializando proveedor/contrato:", err);
  isConfigured = false;
}

async function getUsdcContract() {
  if (!usdcContract) {
    try {
      const usdcAddress = await contract.usdcToken();
      usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
    } catch (err) {
      console.error("❌ Error obteniendo dirección USDC:", err);
      throw err;
    }
  }
  return usdcContract;
}

// ---------- RUTA RAÍZ ----------
app.get("/", (req, res) => {
  res.send("🚀 Backend funcionando correctamente");
});

// ---------- RUTA /api/info (con más detalles de error) ----------
app.get("/api/info", async (req, res) => {
  try {
    // Verificar que contract esté definido
    if (!contract) {
      return res.status(500).json({ error: "Contrato no inicializado" });
    }

    // Llamar a las funciones del contrato
    const [usdcAddress, owner, contractBalance, network] = await Promise.all([
      contract.usdcToken(),
      contract.owner(),
      contract.getContractBalance(),
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
    console.error("❌ Error en /api/info:", err);
    // Enviar mensaje de error detallado pero sin exponer datos sensibles
    res.status(500).json({
      error: "Error al obtener información del contrato",
      details: err.message,
      // Opcional: si es un error de CALL_EXCEPTION, mostrar más datos
      ...(err.code === "CALL_EXCEPTION" && { reason: err.reason, data: err.data }),
    });
  }
});

// ---------- RUTA /api/balance/:address ----------
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
      donation = await contract.calculateRequiredDonation(address);
    } catch (err) {
      // Si el error es por "require(false)" lo manejamos como error de saldo insuficiente
      donationError = "Balance insuficiente para el mínimo de donación (0.1 USDC)";
      // No lanzamos el error para que la respuesta continúe
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
    console.error("❌ Error en /api/balance:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- RUTA /api/donate ----------
app.post("/api/donate", async (req, res) => {
  try {
    const { donor, amount, validAfter, validBefore, nonce, v, r, s } = req.body;

    if (
      !donor || !amount ||
      validAfter === undefined || !validBefore ||
      !nonce || v === undefined || !r || !s
    ) {
      return res.status(400).json({ error: "Faltan campos requeridos en la solicitud" });
    }

    console.log(`📥 Procesando donación de ${donor}...`);

    const tx = await contract.processDonation(
      donor,
      amount,
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

// ---------- RUTA /api/donor/:address ----------
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
    console.error("❌ Error en /api/donor:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- MANEJADOR DE RUTAS NO ENCONTRADAS ----------
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// ---------- MANEJADOR DE ERRORES GLOBAL ----------
app.use((err, req, res, next) => {
  console.error("❌ Error global:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

// ---------- EXPORTACIÓN PARA VERCEL ----------
export default app;
