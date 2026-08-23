/**
 * Phase 24 — demo catalogue.
 *
 * The reference data behind the demo dataset, kept as plain data so the seed
 * script stays readable and the tests can assert against the SAME source
 * rather than a second hard-coded copy.
 *
 * All of it is Nepali-restaurant realistic: real dish names, plausible
 * Kathmandu supplier names, and prices in NPR at roughly 2026 Kathmandu retail.
 * Costs are in the ingredient's BASE UNIT (per gram, per millilitre, per
 * piece), which is what the inventory ledger and food-costing expect — a cost
 * "per kg" written into a gram-based ingredient is the classic way to make
 * every margin report wrong by a factor of a thousand.
 */

/**
 * Ingredients: [code, name, category, unit, costPerBaseUnit, openingQty,
 *               reorderLevel, shelfLifeDays, storage]
 *
 * `openingQty` is in the base unit and is what the KTM branch opens with;
 * other branches open with a fraction of it (see the seed script).
 */
export const INGREDIENTS = Object.freeze([
  // ── Grains, flours and pulses ──────────────────────────────────────────────
  ['ING-001', 'Basmati Rice', 'Grains', 'g', 0.145, 180000, 40000, 540, 'Dry store'],
  ['ING-002', 'Jeera Masino Rice', 'Grains', 'g', 0.098, 120000, 30000, 540, 'Dry store'],
  ['ING-003', 'Beaten Rice (Chiura)', 'Grains', 'g', 0.085, 40000, 10000, 180, 'Dry store'],
  ['ING-004', 'Wheat Flour (Maida)', 'Grains', 'g', 0.062, 90000, 25000, 240, 'Dry store'],
  ['ING-005', 'Wholemeal Flour (Atta)', 'Grains', 'g', 0.058, 70000, 20000, 240, 'Dry store'],
  ['ING-006', 'Gram Flour (Besan)', 'Grains', 'g', 0.115, 25000, 6000, 180, 'Dry store'],
  ['ING-007', 'Black Lentil (Kalo Dal)', 'Pulses', 'g', 0.168, 30000, 8000, 365, 'Dry store'],
  ['ING-008', 'Red Lentil (Musuro Dal)', 'Pulses', 'g', 0.152, 35000, 9000, 365, 'Dry store'],
  ['ING-009', 'Chickpeas (Chana)', 'Pulses', 'g', 0.135, 28000, 7000, 365, 'Dry store'],
  ['ING-010', 'Soybean', 'Pulses', 'g', 0.128, 15000, 4000, 365, 'Dry store'],

  // ── Meat, poultry and fish ─────────────────────────────────────────────────
  ['ING-011', 'Chicken Curry Cut', 'Meat', 'g', 0.395, 45000, 12000, 3, 'Chiller'],
  ['ING-012', 'Chicken Boneless', 'Meat', 'g', 0.520, 30000, 8000, 3, 'Chiller'],
  ['ING-013', 'Chicken Mince (Keema)', 'Meat', 'g', 0.480, 18000, 5000, 2, 'Chiller'],
  ['ING-014', 'Mutton Curry Cut', 'Meat', 'g', 1.250, 20000, 6000, 3, 'Chiller'],
  ['ING-015', 'Buff Mince', 'Meat', 'g', 0.410, 25000, 7000, 2, 'Chiller'],
  ['ING-016', 'Buff Sekuwa Cut', 'Meat', 'g', 0.440, 15000, 4000, 3, 'Chiller'],
  ['ING-017', 'Pork Belly', 'Meat', 'g', 0.560, 12000, 3000, 3, 'Chiller'],
  ['ING-018', 'Fish Fillet (Rohu)', 'Seafood', 'g', 0.620, 10000, 3000, 2, 'Chiller'],
  ['ING-019', 'Prawns', 'Seafood', 'g', 1.480, 6000, 2000, 2, 'Freezer'],
  ['ING-020', 'Eggs', 'Dairy & Eggs', 'pcs', 18.5, 600, 150, 21, 'Chiller'],

  // ── Dairy ──────────────────────────────────────────────────────────────────
  ['ING-021', 'Full Cream Milk', 'Dairy & Eggs', 'ml', 0.098, 60000, 15000, 5, 'Chiller'],
  ['ING-022', 'Curd (Dahi)', 'Dairy & Eggs', 'g', 0.135, 25000, 7000, 7, 'Chiller'],
  ['ING-023', 'Paneer', 'Dairy & Eggs', 'g', 0.680, 12000, 3000, 5, 'Chiller'],
  ['ING-024', 'Butter', 'Dairy & Eggs', 'g', 0.890, 10000, 2500, 90, 'Chiller'],
  ['ING-025', 'Ghee', 'Dairy & Eggs', 'g', 1.150, 12000, 3000, 270, 'Dry store'],
  ['ING-026', 'Cheese (Processed)', 'Dairy & Eggs', 'g', 0.940, 8000, 2000, 120, 'Chiller'],
  ['ING-027', 'Cooking Cream', 'Dairy & Eggs', 'ml', 0.520, 6000, 1500, 60, 'Chiller'],

  // ── Vegetables ─────────────────────────────────────────────────────────────
  ['ING-028', 'Onion', 'Vegetables', 'g', 0.088, 60000, 15000, 30, 'Dry store'],
  ['ING-029', 'Tomato', 'Vegetables', 'g', 0.075, 40000, 10000, 10, 'Chiller'],
  ['ING-030', 'Potato', 'Vegetables', 'g', 0.062, 70000, 18000, 45, 'Dry store'],
  ['ING-031', 'Cabbage', 'Vegetables', 'g', 0.048, 25000, 6000, 14, 'Chiller'],
  ['ING-032', 'Carrot', 'Vegetables', 'g', 0.085, 18000, 5000, 21, 'Chiller'],
  ['ING-033', 'Cauliflower', 'Vegetables', 'g', 0.072, 20000, 5000, 10, 'Chiller'],
  ['ING-034', 'Green Peas', 'Vegetables', 'g', 0.145, 12000, 3000, 180, 'Freezer'],
  ['ING-035', 'Capsicum', 'Vegetables', 'g', 0.135, 10000, 2500, 14, 'Chiller'],
  ['ING-036', 'Mushroom', 'Vegetables', 'g', 0.320, 8000, 2000, 7, 'Chiller'],
  ['ING-037', 'Spinach (Palungo)', 'Vegetables', 'g', 0.060, 12000, 3000, 5, 'Chiller'],
  ['ING-038', 'Green Chilli', 'Vegetables', 'g', 0.180, 5000, 1500, 10, 'Chiller'],
  ['ING-039', 'Coriander Leaves', 'Vegetables', 'g', 0.160, 4000, 1200, 5, 'Chiller'],
  ['ING-040', 'Spring Onion', 'Vegetables', 'g', 0.120, 5000, 1500, 7, 'Chiller'],

  // ── Aromatics and spices ───────────────────────────────────────────────────
  ['ING-041', 'Ginger', 'Aromatics', 'g', 0.240, 8000, 2000, 21, 'Dry store'],
  ['ING-042', 'Garlic', 'Aromatics', 'g', 0.285, 8000, 2000, 60, 'Dry store'],
  ['ING-043', 'Cumin Powder', 'Spices', 'g', 0.780, 4000, 1000, 365, 'Dry store'],
  ['ING-044', 'Coriander Powder', 'Spices', 'g', 0.520, 5000, 1200, 365, 'Dry store'],
  ['ING-045', 'Turmeric Powder', 'Spices', 'g', 0.440, 4000, 1000, 365, 'Dry store'],
  ['ING-046', 'Red Chilli Powder', 'Spices', 'g', 0.620, 4000, 1000, 365, 'Dry store'],
  ['ING-047', 'Garam Masala', 'Spices', 'g', 1.180, 3000, 800, 240, 'Dry store'],
  ['ING-048', 'Biryani Masala', 'Spices', 'g', 1.320, 3000, 800, 240, 'Dry store'],
  ['ING-049', 'Timur (Sichuan Pepper)', 'Spices', 'g', 1.850, 1500, 400, 365, 'Dry store'],
  ['ING-050', 'Bay Leaf', 'Spices', 'g', 0.900, 1000, 300, 365, 'Dry store'],

  // ── Oils, sauces and sundries ──────────────────────────────────────────────
  ['ING-051', 'Sunflower Oil', 'Oils', 'ml', 0.198, 50000, 12000, 365, 'Dry store'],
  ['ING-052', 'Mustard Oil', 'Oils', 'ml', 0.245, 20000, 5000, 365, 'Dry store'],
  ['ING-053', 'Soy Sauce', 'Condiments', 'ml', 0.290, 8000, 2000, 365, 'Dry store'],
  ['ING-054', 'Tomato Ketchup', 'Condiments', 'g', 0.210, 10000, 2500, 270, 'Dry store'],
  ['ING-055', 'Salt', 'Condiments', 'g', 0.028, 20000, 5000, 730, 'Dry store'],
  ['ING-056', 'Sugar', 'Condiments', 'g', 0.105, 25000, 6000, 540, 'Dry store'],
  ['ING-057', 'Tea Leaves (CTC)', 'Beverages', 'g', 0.680, 6000, 1500, 365, 'Dry store'],
  ['ING-058', 'Coffee Beans', 'Beverages', 'g', 1.650, 4000, 1000, 240, 'Dry store'],
  ['ING-059', 'Lemon', 'Vegetables', 'pcs', 12.0, 400, 100, 14, 'Chiller'],
  ['ING-060', 'Takeaway Container', 'Packaging', 'pcs', 14.5, 1200, 300, 3650, 'Dry store']
]);

/**
 * Suppliers: [name, contact, address, paymentTerms, category]
 * `category` records what they actually supply, which the seed uses to link
 * each supplier to plausible ingredients rather than at random.
 */
export const SUPPLIERS = Object.freeze([
  ['Kalimati Fresh Vegetables', '9801100201', 'Kalimati, Kathmandu', 'Net 7', 'Vegetables'],
  ['Everest Grains and Pulses', '9801100202', 'Teku, Kathmandu', 'Net 30', 'Grains'],
  ['Himalayan Meat Suppliers', '9801100203', 'Balaju, Kathmandu', 'Net 15', 'Meat'],
  ['Bagmati Poultry Farm', '9801100204', 'Chobhar, Kathmandu', 'Net 15', 'Meat'],
  ['Nepal Dairy Development', '9801100205', 'Lainchaur, Kathmandu', 'Net 15', 'Dairy & Eggs'],
  ['Annapurna Spice House', '9801100206', 'Ason, Kathmandu', 'Net 30', 'Spices'],
  ['Pashupati Oil Traders', '9801100207', 'Kalanki, Kathmandu', 'Net 30', 'Oils'],
  ['Sagarmatha Seafood', '9801100208', 'Kuleshwor, Kathmandu', 'Net 7', 'Seafood'],
  ['Patan Vegetable Collective', '9801100209', 'Lagankhel, Lalitpur', 'Net 7', 'Vegetables'],
  ['Bhaktapur Curd House', '9801100210', 'Taumadhi, Bhaktapur', 'Net 7', 'Dairy & Eggs'],
  ['Terai Rice Mills', '9801100211', 'Birgunj Depot, Kathmandu', 'Net 45', 'Grains'],
  ['Kathmandu Beverage Depot', '9801100212', 'New Road, Kathmandu', 'Net 30', 'Beverages'],
  ['Manakamana Condiments', '9801100213', 'Kalimati, Kathmandu', 'Net 30', 'Condiments'],
  ['Solu Aromatics Trading', '9801100214', 'Ason, Kathmandu', 'Net 30', 'Aromatics'],
  ['Green Valley Packaging', '9801100215', 'Satdobato, Lalitpur', 'Net 45', 'Packaging'],
  ['Newa Pulses Wholesale', '9801100216', 'Bhotahity, Kathmandu', 'Net 30', 'Pulses']
]);

/**
 * Menu: [name, nameNp, category, price, vatInclusive, station, prepMinutes,
 *        packagingCost, recipe]
 *
 * `recipe` is [ingredientCode, qtyInBaseUnit]. Quantities are per single
 * serving and are costed so that food cost lands in a believable 25-38% band —
 * a demo where every dish shows a 90% margin teaches an operator nothing.
 */
export const MENU = Object.freeze([
  // ── Biryani ────────────────────────────────────────────────────────────────
  ['Chicken Biryani', 'चिकेन बिरयानी', 'Biryani', 420, false, 'hot', 18, 0,
    [['ING-001', 220], ['ING-011', 180], ['ING-028', 60], ['ING-022', 40], ['ING-048', 10], ['ING-025', 15], ['ING-041', 6], ['ING-042', 6]]],
  ['Mutton Biryani', 'मटन बिरयानी', 'Biryani', 780, false, 'hot', 25, 0,
    [['ING-001', 220], ['ING-014', 170], ['ING-028', 60], ['ING-022', 40], ['ING-048', 12], ['ING-025', 18], ['ING-041', 6], ['ING-042', 6]]],
  ['Veg Biryani', 'भेज बिरयानी', 'Biryani', 320, false, 'hot', 15, 0,
    [['ING-001', 220], ['ING-032', 50], ['ING-034', 45], ['ING-033', 60], ['ING-028', 50], ['ING-048', 9], ['ING-025', 12]]],
  ['Egg Biryani', 'अण्डा बिरयानी', 'Biryani', 340, false, 'hot', 15, 0,
    [['ING-001', 220], ['ING-020', 2], ['ING-028', 50], ['ING-048', 9], ['ING-025', 12], ['ING-029', 40]]],
  ['Prawn Biryani', 'झिंगे बिरयानी', 'Biryani', 720, false, 'hot', 22, 0,
    [['ING-001', 220], ['ING-019', 140], ['ING-028', 55], ['ING-048', 10], ['ING-025', 15], ['ING-042', 6]]],

  // ── Momo ───────────────────────────────────────────────────────────────────
  ['Chicken Steam Momo', 'चिकेन स्टिम मम', 'Momo', 220, false, 'hot', 14, 0,
    [['ING-004', 110], ['ING-013', 120], ['ING-028', 45], ['ING-039', 8], ['ING-041', 5], ['ING-042', 5], ['ING-055', 3]]],
  ['Buff Steam Momo', 'बफ स्टिम मम', 'Momo', 200, false, 'hot', 14, 0,
    [['ING-004', 110], ['ING-015', 120], ['ING-028', 45], ['ING-039', 8], ['ING-041', 5], ['ING-042', 5]]],
  ['Veg Steam Momo', 'भेज स्टिम मम', 'Momo', 170, false, 'hot', 12, 0,
    [['ING-004', 110], ['ING-031', 90], ['ING-032', 40], ['ING-028', 35], ['ING-039', 8], ['ING-041', 4]]],
  ['Paneer Momo', 'पनिर मम', 'Momo', 240, false, 'hot', 14, 0,
    [['ING-004', 110], ['ING-023', 100], ['ING-028', 35], ['ING-039', 8], ['ING-041', 4]]],
  ['Chicken Fry Momo', 'चिकेन फ्राई मम', 'Momo', 260, false, 'fry', 16, 0,
    [['ING-004', 110], ['ING-013', 120], ['ING-028', 45], ['ING-051', 40], ['ING-046', 4], ['ING-041', 5]]],
  ['Buff Jhol Momo', 'बफ झोल मम', 'Momo', 240, false, 'hot', 16, 0,
    [['ING-004', 110], ['ING-015', 120], ['ING-029', 70], ['ING-049', 3], ['ING-046', 4], ['ING-041', 5], ['ING-042', 5]]],
  ['Chicken C Momo', 'चिकेन सी मम', 'Momo', 280, false, 'fry', 17, 0,
    [['ING-004', 110], ['ING-013', 120], ['ING-054', 35], ['ING-046', 5], ['ING-051', 35], ['ING-042', 5]]],

  // ── Thali and Nepali mains ─────────────────────────────────────────────────
  ['Veg Khana Set', 'भेज खाना सेट', 'Thali', 320, false, 'hot', 16, 0,
    [['ING-002', 250], ['ING-008', 70], ['ING-030', 90], ['ING-031', 70], ['ING-037', 50], ['ING-052', 18], ['ING-045', 3]]],
  ['Chicken Khana Set', 'चिकेन खाना सेट', 'Thali', 450, false, 'hot', 20, 0,
    [['ING-002', 250], ['ING-008', 70], ['ING-011', 150], ['ING-030', 80], ['ING-037', 50], ['ING-052', 20], ['ING-047', 5]]],
  ['Mutton Khana Set', 'मटन खाना सेट', 'Thali', 720, false, 'hot', 26, 0,
    [['ING-002', 250], ['ING-007', 70], ['ING-014', 150], ['ING-030', 80], ['ING-037', 50], ['ING-052', 20], ['ING-047', 6]]],
  ['Fish Khana Set', 'माछा खाना सेट', 'Thali', 520, false, 'hot', 22, 0,
    [['ING-002', 250], ['ING-008', 70], ['ING-018', 150], ['ING-030', 80], ['ING-052', 20], ['ING-045', 4]]],
  ['Dal Bhat Tarkari', 'दाल भात तरकारी', 'Thali', 280, false, 'hot', 15, 0,
    [['ING-002', 250], ['ING-008', 80], ['ING-030', 100], ['ING-033', 70], ['ING-052', 18], ['ING-045', 3]]],

  // ── Curries ────────────────────────────────────────────────────────────────
  ['Chicken Curry', 'चिकेन तरकारी', 'Curry', 380, false, 'hot', 20, 0,
    [['ING-011', 200], ['ING-028', 70], ['ING-029', 60], ['ING-041', 8], ['ING-042', 8], ['ING-047', 6], ['ING-051', 25]]],
  ['Mutton Curry', 'मटन तरकारी', 'Curry', 740, false, 'hot', 28, 0,
    [['ING-014', 200], ['ING-028', 70], ['ING-029', 60], ['ING-041', 8], ['ING-042', 8], ['ING-047', 7], ['ING-052', 25]]],
  ['Butter Chicken', 'बटर चिकेन', 'Curry', 480, false, 'hot', 22, 0,
    [['ING-012', 180], ['ING-024', 30], ['ING-027', 50], ['ING-029', 80], ['ING-046', 4], ['ING-047', 5], ['ING-042', 6]]],
  ['Paneer Butter Masala', 'पनिर बटर मसाला', 'Curry', 420, false, 'hot', 18, 0,
    [['ING-023', 160], ['ING-024', 25], ['ING-027', 45], ['ING-029', 80], ['ING-047', 5], ['ING-042', 5]]],
  ['Kadai Chicken', 'कढाई चिकेन', 'Curry', 450, false, 'hot', 20, 0,
    [['ING-012', 180], ['ING-035', 60], ['ING-028', 60], ['ING-029', 60], ['ING-047', 6], ['ING-051', 25]]],
  ['Mushroom Masala', 'च्याउ मसाला', 'Curry', 360, false, 'hot', 16, 0,
    [['ING-036', 170], ['ING-028', 60], ['ING-029', 60], ['ING-027', 30], ['ING-047', 5], ['ING-051', 20]]],
  ['Aloo Tama', 'आलु टामा', 'Curry', 260, false, 'hot', 16, 0,
    [['ING-030', 150], ['ING-009', 60], ['ING-028', 50], ['ING-045', 3], ['ING-052', 18], ['ING-049', 2]]],
  ['Kalo Dal', 'कालो दाल', 'Curry', 220, false, 'hot', 14, 0,
    [['ING-007', 90], ['ING-024', 15], ['ING-028', 40], ['ING-041', 5], ['ING-042', 5], ['ING-047', 3]]],

  // ── Grill and sekuwa ───────────────────────────────────────────────────────
  ['Chicken Sekuwa', 'चिकेन सेकुवा', 'Grill', 420, false, 'grill', 20, 0,
    [['ING-012', 200], ['ING-041', 8], ['ING-042', 8], ['ING-049', 3], ['ING-046', 4], ['ING-052', 20]]],
  ['Buff Sekuwa', 'बफ सेकुवा', 'Grill', 400, false, 'grill', 22, 0,
    [['ING-016', 200], ['ING-041', 8], ['ING-042', 8], ['ING-049', 4], ['ING-046', 4], ['ING-052', 20]]],
  ['Pork Sekuwa', 'सुँगुर सेकुवा', 'Grill', 460, false, 'grill', 24, 0,
    [['ING-017', 200], ['ING-041', 8], ['ING-042', 8], ['ING-049', 4], ['ING-052', 20]]],
  ['Chicken Tandoori Half', 'चिकेन तन्दुरी', 'Grill', 480, false, 'grill', 25, 0,
    [['ING-011', 350], ['ING-022', 60], ['ING-046', 6], ['ING-047', 5], ['ING-041', 8], ['ING-042', 8]]],
  ['Fish Tandoori', 'माछा तन्दुरी', 'Grill', 560, false, 'grill', 22, 0,
    [['ING-018', 220], ['ING-022', 50], ['ING-046', 5], ['ING-047', 4], ['ING-059', 1]]],
  ['Paneer Tikka', 'पनिर टिक्का', 'Grill', 400, false, 'grill', 18, 0,
    [['ING-023', 180], ['ING-022', 50], ['ING-035', 50], ['ING-028', 40], ['ING-047', 4]]],

  // ── Chowmein, fried rice and noodles ───────────────────────────────────────
  ['Chicken Chowmein', 'चिकेन चाउमिन', 'Noodles', 280, false, 'fry', 14, 0,
    [['ING-004', 150], ['ING-012', 100], ['ING-031', 70], ['ING-032', 40], ['ING-040', 20], ['ING-053', 15], ['ING-051', 30]]],
  ['Veg Chowmein', 'भेज चाउमिन', 'Noodles', 220, false, 'fry', 12, 0,
    [['ING-004', 150], ['ING-031', 90], ['ING-032', 50], ['ING-035', 35], ['ING-040', 20], ['ING-053', 15], ['ING-051', 28]]],
  ['Buff Chowmein', 'बफ चाउमिन', 'Noodles', 260, false, 'fry', 14, 0,
    [['ING-004', 150], ['ING-015', 100], ['ING-031', 70], ['ING-032', 40], ['ING-053', 15], ['ING-051', 30]]],
  ['Chicken Fried Rice', 'चिकेन फ्राइड राइस', 'Rice', 300, false, 'fry', 13, 0,
    [['ING-002', 220], ['ING-012', 100], ['ING-020', 1], ['ING-034', 35], ['ING-032', 35], ['ING-053', 12], ['ING-051', 28]]],
  ['Veg Fried Rice', 'भेज फ्राइड राइस', 'Rice', 240, false, 'fry', 12, 0,
    [['ING-002', 220], ['ING-034', 40], ['ING-032', 40], ['ING-035', 35], ['ING-053', 12], ['ING-051', 26]]],
  ['Egg Fried Rice', 'अण्डा फ्राइड राइस', 'Rice', 260, false, 'fry', 12, 0,
    [['ING-002', 220], ['ING-020', 2], ['ING-040', 20], ['ING-053', 12], ['ING-051', 26]]],
  ['Thukpa Chicken', 'चिकेन थुक्पा', 'Noodles', 290, false, 'hot', 16, 0,
    [['ING-004', 130], ['ING-012', 100], ['ING-031', 60], ['ING-032', 35], ['ING-041', 6], ['ING-046', 3]]],

  // ── Snacks and starters ────────────────────────────────────────────────────
  ['Chicken Chilli', 'चिकेन चिल्ली', 'Starter', 380, false, 'fry', 16, 0,
    [['ING-012', 170], ['ING-035', 60], ['ING-028', 50], ['ING-053', 15], ['ING-051', 40], ['ING-038', 10]]],
  ['Chilli Paneer', 'चिल्ली पनिर', 'Starter', 350, false, 'fry', 15, 0,
    [['ING-023', 160], ['ING-035', 60], ['ING-028', 50], ['ING-053', 15], ['ING-051', 35]]],
  ['Mushroom Chilli', 'च्याउ चिल्ली', 'Starter', 330, false, 'fry', 15, 0,
    [['ING-036', 160], ['ING-035', 55], ['ING-028', 45], ['ING-053', 14], ['ING-051', 32]]],
  ['Chicken Pakoda', 'चिकेन पकौडा', 'Starter', 300, false, 'fry', 14, 0,
    [['ING-013', 140], ['ING-006', 70], ['ING-046', 4], ['ING-051', 50], ['ING-042', 5]]],
  ['Onion Pakoda', 'प्याज पकौडा', 'Starter', 180, false, 'fry', 10, 0,
    [['ING-028', 130], ['ING-006', 80], ['ING-046', 4], ['ING-051', 45]]],
  ['French Fries', 'फ्रेन्च फ्राइज', 'Starter', 200, false, 'fry', 9, 0,
    [['ING-030', 200], ['ING-051', 45], ['ING-055', 3], ['ING-054', 25]]],
  ['Chicken Sausage Fry', 'चिकेन सस्यज', 'Starter', 320, false, 'fry', 11, 0,
    [['ING-013', 150], ['ING-028', 40], ['ING-046', 3], ['ING-051', 30]]],
  ['Wai Wai Sadeko', 'वाइवाइ सादेको', 'Starter', 160, false, 'cold', 7, 0,
    [['ING-004', 70], ['ING-028', 45], ['ING-029', 40], ['ING-038', 8], ['ING-039', 6], ['ING-052', 12]]],
  ['Chiura Sadeko', 'चिउरा सादेको', 'Starter', 150, false, 'cold', 7, 0,
    [['ING-003', 80], ['ING-028', 45], ['ING-029', 35], ['ING-038', 8], ['ING-052', 12]]],
  ['Bhatmas Sadeko', 'भटमास सादेको', 'Starter', 180, false, 'cold', 8, 0,
    [['ING-010', 90], ['ING-028', 40], ['ING-038', 8], ['ING-039', 6], ['ING-052', 14], ['ING-049', 2]]],

  // ── Breads and sides ───────────────────────────────────────────────────────
  ['Butter Naan', 'बटर नान', 'Bread', 90, false, 'tandoor', 8, 0,
    [['ING-004', 90], ['ING-024', 12], ['ING-021', 25], ['ING-055', 2]]],
  ['Garlic Naan', 'लसुन नान', 'Bread', 110, false, 'tandoor', 8, 0,
    [['ING-004', 90], ['ING-024', 12], ['ING-042', 8], ['ING-021', 25]]],
  ['Plain Roti', 'रोटी', 'Bread', 45, false, 'tandoor', 6, 0,
    [['ING-005', 80], ['ING-055', 2]]],
  ['Selroti', 'सेलरोटी', 'Bread', 80, false, 'fry', 10, 0,
    [['ING-001', 70], ['ING-056', 25], ['ING-021', 30], ['ING-051', 25]]],
  ['Steamed Rice', 'भात', 'Rice', 110, false, 'hot', 10, 0,
    [['ING-002', 220], ['ING-055', 2]]],
  ['Jeera Rice', 'जीरा भात', 'Rice', 150, false, 'hot', 11, 0,
    [['ING-001', 200], ['ING-043', 5], ['ING-025', 10]]],
  ['Mixed Achar', 'मिश्रित अचार', 'Side', 70, false, 'cold', 4, 0,
    [['ING-029', 50], ['ING-038', 10], ['ING-052', 10], ['ING-045', 2], ['ING-055', 2]]],
  ['Green Salad', 'सलाद', 'Side', 90, false, 'cold', 5, 0,
    [['ING-032', 45], ['ING-029', 45], ['ING-031', 40], ['ING-059', 1]]],

  // ── Beverages and dessert ──────────────────────────────────────────────────
  ['Milk Tea', 'दुध चिया', 'Beverage', 50, true, 'beverage', 5, 0,
    [['ING-021', 120], ['ING-057', 6], ['ING-056', 12]]],
  ['Black Tea', 'कालो चिया', 'Beverage', 35, true, 'beverage', 4, 0,
    [['ING-057', 5], ['ING-056', 10]]],
  ['Masala Tea', 'मसला चिया', 'Beverage', 60, true, 'beverage', 6, 0,
    [['ING-021', 120], ['ING-057', 6], ['ING-056', 12], ['ING-047', 2]]],
  ['Americano', 'अमेरिकानो', 'Beverage', 130, true, 'beverage', 5, 0,
    [['ING-058', 18], ['ING-056', 8]]],
  ['Cappuccino', 'क्यापुचिनो', 'Beverage', 170, true, 'beverage', 6, 0,
    [['ING-058', 18], ['ING-021', 130], ['ING-056', 8]]],
  ['Lassi', 'लस्सी', 'Beverage', 120, true, 'beverage', 5, 0,
    [['ING-022', 180], ['ING-056', 25]]],
  ['Fresh Lime Soda', 'लिम्बु सोडा', 'Beverage', 100, true, 'beverage', 4, 0,
    [['ING-059', 2], ['ING-056', 20], ['ING-055', 1]]],
  ['Juju Dhau', 'जुजु धौ', 'Dessert', 140, true, 'cold', 4, 0,
    [['ING-022', 200], ['ING-056', 22]]],
  ['Kheer', 'खीर', 'Dessert', 130, true, 'hot', 12, 0,
    [['ING-021', 180], ['ING-001', 45], ['ING-056', 30], ['ING-025', 8]]]
]);

/** Table layouts per branch code. [name, area, seats] */
export const TABLES = Object.freeze({
  KTM: [
    ['T1', 'Ground Floor', 4], ['T2', 'Ground Floor', 4], ['T3', 'Ground Floor', 2],
    ['T4', 'Ground Floor', 6], ['T5', 'First Floor', 4], ['T6', 'First Floor', 4],
    ['T7', 'First Floor', 8], ['T8', 'Terrace', 4], ['T9', 'Terrace', 4],
    ['T10', 'Family Cabin', 6], ['T11', 'Family Cabin', 6], ['T12', 'Terrace', 2]
  ],
  LTP: [
    ['L1', 'Courtyard', 4], ['L2', 'Courtyard', 4], ['L3', 'Courtyard', 2],
    ['L4', 'Indoor', 6], ['L5', 'Indoor', 4], ['L6', 'Indoor', 4],
    ['L7', 'Garden', 8], ['L8', 'Garden', 4]
  ],
  BKT: [
    ['B1', 'Main Hall', 4], ['B2', 'Main Hall', 4], ['B3', 'Main Hall', 6],
    ['B4', 'Rooftop', 4], ['B5', 'Rooftop', 4], ['B6', 'Rooftop', 2]
  ]
});

/** Customers: [name, phone, area, dietary, spice, tier] */
export const CUSTOMERS = Object.freeze([
  ['Anisha Shrestha', '9841000101', 'Baluwatar, Kathmandu', 'none', 'medium', 'gold'],
  ['Bikash Tamang', '9841000102', 'Chabahil, Kathmandu', 'none', 'hot', 'silver'],
  ['Sunita Maharjan', '9841000103', 'Kirtipur, Kathmandu', 'vegetarian', 'mild', 'bronze'],
  ['Rajesh Gurung', '9841000104', 'Baneshwor, Kathmandu', 'none', 'extra-hot', 'platinum'],
  ['Pooja Rai', '9841000105', 'Jhamsikhel, Lalitpur', 'none', 'medium', 'silver'],
  ['Deepak Thapa', '9841000106', 'Pulchowk, Lalitpur', 'none', 'hot', 'bronze'],
  ['Manisha Karki', '9841000107', 'Suryabinayak, Bhaktapur', 'vegetarian', 'mild', 'bronze'],
  ['Nabin Adhikari', '9841000108', 'Thimi, Bhaktapur', 'none', 'medium', 'silver'],
  ['Sabina Lama', '9841000109', 'Maharajgunj, Kathmandu', 'halal', 'medium', 'gold'],
  ['Prakash Bhandari', '9841000110', 'Kalanki, Kathmandu', 'none', 'hot', 'bronze'],
  ['Rekha Joshi', '9841000111', 'Sanepa, Lalitpur', 'vegan', 'mild', 'silver'],
  ['Suman Magar', '9841000112', 'Koteshwor, Kathmandu', 'none', 'medium', 'bronze'],
  ['Kritika Basnet', '9841000113', 'Bouddha, Kathmandu', 'none', 'medium', 'gold'],
  ['Hari Poudel', '9841000114', 'Balkumari, Lalitpur', 'none', 'hot', 'bronze'],
  ['Anita Sherpa', '9841000115', 'Dhapasi, Kathmandu', 'none', 'mild', 'silver'],
  ['Ramesh Khadka', '9841000116', 'Gongabu, Kathmandu', 'none', 'extra-hot', 'bronze'],
  ['Sarita Dahal', '9841000117', 'Ekantakuna, Lalitpur', 'vegetarian', 'medium', 'silver'],
  ['Binod Chaudhary', '9841000118', 'Naxal, Kathmandu', 'none', 'medium', 'platinum'],
  ['Laxmi Neupane', '9841000119', 'Kamalpokhari, Kathmandu', 'none', 'mild', 'bronze'],
  ['Gopal Shakya', '9841000120', 'Patan Durbar, Lalitpur', 'none', 'hot', 'gold']
]);
