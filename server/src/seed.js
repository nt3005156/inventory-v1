import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {User, Supplier, Ingredient, MenuItem} from './models/index.js';
import {SupplierIngredient, SupplierPriceHistory} from './models/supplierCatalog.js';
import {Restaurant, Branch, InventoryBalance, InventoryBatch, InventoryTransaction, RestaurantTable} from './models/operations.js';
import {moveStock} from './services/inventoryLedger.js';

await mongoose.connect(process.env.MONGODB_URI);
await Promise.all([
  User.deleteMany(), Supplier.deleteMany(), Ingredient.deleteMany(), MenuItem.deleteMany(),
  SupplierIngredient.deleteMany(), SupplierPriceHistory.deleteMany(), Restaurant.deleteMany(),
  Branch.deleteMany(), InventoryBalance.collection.deleteMany({}), InventoryBatch.collection.deleteMany({}), InventoryTransaction.collection.deleteMany({}), RestaurantTable.deleteMany()
]);

const business = await Restaurant.create({
  name: 'Mittho Biryani House', currency: 'NPR', vatRate: 13, address: 'Kathmandu, Nepal'
});
const [ktm, lalitpur, bhaktapur] = await Branch.create([
  {restaurant: business._id, name: 'Kathmandu Branch', code: 'KTM', address: 'Kalanki, Kathmandu'},
  {restaurant: business._id, name: 'Lalitpur Branch', code: 'LTP', address: 'Patan, Lalitpur'},
  {restaurant: business._id, name: 'Bhaktapur Branch', code: 'BKT', address: 'Suryabinayak, Bhaktapur'}
]);
const owner = await User.create({
  name: 'Mittho Owner', email: 'owner@mittho.com', password: await bcrypt.hash('mittho123', 12),
  role: 'owner', restaurant: business.name, restaurantId: business._id
});
await User.create({
  name: 'Kitchen Staff', email: 'staff@mittho.com', password: await bcrypt.hash('mittho123', 12),
  role: 'staff', restaurant: business.name, restaurantId: business._id, branch: ktm._id
});
const supplier = await Supplier.create({
  restaurant: business._id,
  name: 'Kathmandu Food Suppliers',
  contact: '9800000000',
  address: 'Kalanki, Kathmandu',
  paymentTerms: '15 days'
});
const raw = [
  ['ING-001', 'Basmati Rice', 'Rice', 45, 180, 20],
  ['ING-002', 'Chicken', 'Meat', 360, 35, 8],
  ['ING-003', 'Cooking Oil', 'Oil', 180, 20, 5],
  ['ING-004', 'Biryani Masala', 'Spices', 900, 12, 3],
  ['ING-005', 'Onion', 'Vegetables', 90, 30, 8]
];
const ings = [];
for (const [code, name, category, cost, stock, min] of raw) {
  ings.push(await Ingredient.create({
    restaurant: business._id, code, name, category, unit: 'g',
    lastPurchasePrice: cost, minimumStock: min * 1000, reorderQty: min * 2000,
    supplier: supplier._id
  }));
}
for (let index = 0; index < ings.length; index += 1) {
  const item = await SupplierIngredient.create({
    restaurant: business._id,
    supplier: supplier._id,
    ingredient: ings[index]._id,
    supplierSku: `KFS-${raw[index][0]}`,
    purchaseUnit: 'kg',
    baseUnit: 'g',
    conversionFactor: 1000,
    currentPrice: raw[index][3],
    minOrderQty: 1,
    leadDays: 2,
    createdBy: owner._id,
    updatedBy: owner._id
  });
  await SupplierPriceHistory.create({
    restaurant: business._id,
    catalogItem: item._id,
    supplier: supplier._id,
    ingredient: ings[index]._id,
    price: item.currentPrice,
    purchaseUnit: item.purchaseUnit,
    baseUnit: item.baseUnit,
    conversionFactor: item.conversionFactor,
    priceIncludesVat: false,
    vatRate: 13,
    reason: 'Demo opening supplier price',
    changedBy: owner._id
  });
}
const openingSession=await mongoose.startSession();
try{
  await openingSession.withTransaction(async()=>{
    for(const branch of [ktm,lalitpur,bhaktapur]){
      for(let index=0;index<ings.length;index+=1){
        const ingredient=ings[index];
        const qty=Math.round(raw[index][4]*1000*(branch._id.equals(ktm._id)?1:0.55));
        const unitCost=raw[index][3]/1000;
        await moveStock({
          branch:branch._id,
          ingredient:ingredient._id,
          qty,
          unit:ingredient.unit,
          unitCost,
          type:'OPENING',
          reason:'Demo opening stock',
          referenceType:'demo_seed',
          referenceId:ingredient._id,
          user:owner._id,
          idempotencyKey:`demo-opening:${branch._id}:${ingredient._id}`
        },openingSession);
        await InventoryBalance.updateOne(
          {branch:branch._id,ingredient:ingredient._id},
          {$set:{minLevel:ingredient.minimumStock,reorderLevel:ingredient.reorderQty}},
          {session:openingSession}
        );
      }
    }
  });
}finally{
  await openingSession.endSession();
}
await RestaurantTable.create([
  {branch: ktm._id, name: 'T1', area: 'Main Hall', seats: 4},
  {branch: ktm._id, name: 'T2', area: 'Main Hall', seats: 4},
  {branch: ktm._id, name: 'T3', area: 'Family Area', seats: 6},
  {branch: lalitpur._id, name: 'L1', area: 'Patio', seats: 4},
  {branch: bhaktapur._id, name: 'B1', area: 'Courtyard', seats: 4}
]);
await MenuItem.create([
  {
    name: 'Chicken Biryani', nameNp: 'चिकेन बिरयानी', category: 'Biryani', price: 350,
    vatInclusive: false,
    recipe: [
      {ingredient: ings[0]._id, qty: 250}, {ingredient: ings[1]._id, qty: 180},
      {ingredient: ings[2]._id, qty: 20}, {ingredient: ings[3]._id, qty: 8},
      {ingredient: ings[4]._id, qty: 60}
    ]
  },
  {
    name: 'Chicken Family Pack', nameNp: 'फ्यामिली प्याक', category: 'Combo', price: 1250,
    vatInclusive: false,
    recipe: [
      {ingredient: ings[0]._id, qty: 900}, {ingredient: ings[1]._id, qty: 600},
      {ingredient: ings[2]._id, qty: 60}, {ingredient: ings[3]._id, qty: 30}
    ]
  }
]);
console.log('Seeded 3 branches and the connected supplier catalog. Login owner@mittho.com / mittho123');
await mongoose.disconnect();
