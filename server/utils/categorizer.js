// Keyword-based auto-categorization engine
const CATEGORY_KEYWORDS = {
    'Food & Drink': {
        keywords: [
            'food', 'lunch', 'dinner', 'breakfast', 'brunch', 'snack', 'meal',
            'restaurant', 'cafe', 'coffee', 'tea', 'pizza', 'burger', 'sushi',
            'noodle', 'rice', 'chicken', 'biryani', 'dosa', 'thali', 'paratha',
            'sandwich', 'salad', 'soup', 'steak', 'bbq', 'grill', 'bakery',
            'dessert', 'ice cream', 'cake', 'pastry', 'donut', 'chocolate',
            'beer', 'wine', 'drink', 'juice', 'smoothie', 'bar', 'pub',
            'swiggy', 'zomato', 'ubereats', 'doordash', 'grubhub',
            'dominos', 'mcdonalds', 'kfc', 'starbucks', 'subway',
            'grocery', 'groceries', 'supermarket', 'vegetables', 'fruits',
            'milk', 'bread', 'eggs', 'meat', 'fish', 'water bottle',
        ],
        weight: 1,
    },
    'Transport': {
        keywords: [
            'uber', 'lyft', 'ola', 'rapido', 'taxi', 'cab', 'auto', 'rickshaw',
            'bus', 'train', 'metro', 'subway', 'tram', 'flight', 'airline',
            'fuel', 'gas', 'petrol', 'diesel', 'parking', 'toll',
            'ride', 'commute', 'travel fare', 'transit',
            'car rental', 'bike', 'scooter', 'vehicle',
        ],
        weight: 1,
    },
    'Entertainment': {
        keywords: [
            'movie', 'cinema', 'theatre', 'theater', 'concert', 'show',
            'netflix', 'spotify', 'prime', 'disney', 'hulu', 'youtube',
            'game', 'gaming', 'playstation', 'xbox', 'steam', 'nintendo',
            'party', 'club', 'karaoke', 'bowling', 'arcade',
            'subscription', 'streaming', 'music', 'ticket', 'event',
            'amusement', 'park', 'zoo', 'museum', 'gallery',
        ],
        weight: 1,
    },
    'Shopping': {
        keywords: [
            'shopping', 'amazon', 'flipkart', 'myntra', 'ebay', 'walmart',
            'clothes', 'clothing', 'shirt', 'pants', 'jeans', 'shoes', 'sneakers',
            'electronics', 'gadget', 'phone', 'laptop', 'tablet', 'headphone',
            'furniture', 'decor', 'home goods', 'appliance',
            'gift', 'present', 'accessories', 'watch', 'jewelry',
            'cosmetics', 'makeup', 'skincare', 'perfume',
            'book', 'stationery', 'office supplies',
        ],
        weight: 1,
    },
    'Utilities': {
        keywords: [
            'electricity', 'electric bill', 'power bill', 'light bill',
            'water bill', 'gas bill', 'internet', 'wifi', 'broadband',
            'phone bill', 'mobile recharge', 'data plan',
            'utility', 'utilities', 'cable', 'tv bill',
            'maintenance', 'repair', 'plumber', 'electrician',
            'laundry', 'dry cleaning', 'cleaning',
        ],
        weight: 1,
    },
    'Rent & Housing': {
        keywords: [
            'rent', 'lease', 'mortgage', 'housing', 'apartment',
            'flat', 'room', 'accommodation', 'deposit', 'security deposit',
            'property', 'house', 'home', 'tenant', 'landlord',
            'society', 'maintenance fee', 'hoa',
        ],
        weight: 1.2,
    },
    'Health': {
        keywords: [
            'doctor', 'hospital', 'clinic', 'medical', 'medicine', 'pharmacy',
            'health', 'dental', 'dentist', 'eye', 'optician', 'glasses',
            'gym', 'fitness', 'yoga', 'workout', 'protein',
            'insurance', 'health insurance', 'therapy', 'therapist',
            'vaccine', 'test', 'lab', 'diagnosis', 'prescription',
        ],
        weight: 1,
    },
    'Travel': {
        keywords: [
            'hotel', 'hostel', 'airbnb', 'booking', 'resort',
            'vacation', 'holiday', 'trip', 'tour', 'travel',
            'passport', 'visa', 'luggage', 'suitcase',
            'sightseeing', 'excursion', 'adventure',
            'makemytrip', 'goibibo', 'expedia', 'trivago',
        ],
        weight: 1.1,
    }
};

/**
 * Categorize a description. If `db` is provided, custom categories (with their 
 * user-defined keywords) are checked FIRST and take priority over built-in categories.
 */
function categorize(description, db) {
    if (!description) return 'Other';

    const lower = description.toLowerCase().trim();
    const scores = {};

    // 1. Check custom categories first (they take priority)
    if (db) {
        try {
            const customCats = db.prepare(
                `SELECT name, keywords FROM categories WHERE is_custom = 1 AND keywords IS NOT NULL`
            ).all();

            for (const cat of customCats) {
                let kws = [];
                try { kws = JSON.parse(cat.keywords); } catch { continue; }
                if (!Array.isArray(kws)) continue;

                for (const kw of kws) {
                    const kwLower = kw.toLowerCase().trim();
                    if (kwLower && lower.includes(kwLower)) {
                        // Custom categories get a strong priority boost
                        scores[cat.name] = (scores[cat.name] || 0) + kwLower.length * 2.5;
                    }
                }
            }
        } catch (e) {
            // DB not available or query failed — fall through to built-ins
        }
    }

    // 2. Check built-in categories
    for (const [category, { keywords, weight }] of Object.entries(CATEGORY_KEYWORDS)) {
        let score = 0;
        for (const keyword of keywords) {
            if (lower.includes(keyword)) {
                score += keyword.length * weight;
            }
        }
        if (score > 0) {
            scores[category] = (scores[category] || 0) + score;
        }
    }

    if (Object.keys(scores).length === 0) return 'Other';

    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

module.exports = { categorize };
