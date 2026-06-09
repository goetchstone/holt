// /app/src/data/productOptions.ts
export const vendors = [
  {
    id: "wesley_hall",
    name: "Wesley Hall",
    frames: [
      {
        id: "660",
        name: "660 Chair",
        basePrice: 3075,
        groupLabel: "Grade",
        groupings: [
          { grade: "12", price: 3075 },
          { grade: "20", price: 3195 },
          { grade: "25", price: 3255 },
        ],
        fabricsByGrade: {
          "12": ["Linen White", "Canvas Stone"],
          "20": ["Velvet Navy", "Velvet Charcoal"],
          "25": ["Woven Platinum"],
        },
        options: [
          { type: "finish", name: "Decorative", upcharge: 300 },
          { type: "pillow", name: "20x20 Feather Down", upcharge: 165 },
        ],
      },
    ],
  },
];
