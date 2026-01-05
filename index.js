const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  Timestamp,
} = require("mongodb");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const admin = require("firebase-admin");

dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const bodyParser = require("body-parser");

//load environment
const app = express();
const port = process.env.port || 5000;

//middle ware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dmnxhxd.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    // code starts from here =>

    const parcelCollection = client.db("parcelDB").collection("parcels");
    const paymentsCollection = client.db("parcelDB").collection("payments");
    const usersCollection = client.db("parcelDB").collection("users");
    const ridersCollection = client.db("parcelDB").collection("riders");
    const trackingsCollection = client.db("parcelDB").collection("trackings");

    // custom middlewares

    const verifyFBToken = async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res.status(401).send({ message: "Unauthorized" });
        }

        const token = authHeader.split(" ")[1];

        const decodedUser = await admin.auth().verifyIdToken(token);
        req.decoded = decodedUser;

        next();
      } catch (error) {
        console.error("Token verification error:", error);
        res.status(403).send({ message: "Forbidden" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // user collection post

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        // TODO : update last login info
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // getting users using requery email

    app.get("/users/search", async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery) {
        return res.status(400).send({ message: "Missing Email Query" });
      }
      const regex = new RegExp(emailQuery, "i"); // case insensitive partial match
      try {
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          .limit(10)
          .toArray();
        res.send(users);
      } catch (error) {
        console.log("Error searching users", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });

    // finding user info using email

    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }
        const user = await usersCollection.findOne({ email });
        if (!user) {
          res.status(404).send({ message: "User not found" });
        }
        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error getting user role", error);
        res.status(500).send({ message: "Failed to get role" });
      }
    });

    // getting user role changed

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;
        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid Role" });
        }

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
        } catch (error) {
          console.error("Error updating user role", error);
          res.status(500).send({ message: "Failed to update user role" });
        }
      }
    );

    // basic get all parcels

    // app.get("/parcels", async (req, res) => {
    //   const parcels = await parcelCollection.find().toArray();
    //   res.send(parcels);
    // });

    // get all parcels by user (created_by) , sorted by latest

    app.get("/parcels", async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;
        let query = {};
        if (email) {
          query = { created_by: email };
        }
        if (payment_status) {
          query.payment_status = payment_status;
        }
        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

        // console.log(query);

        const options = {
          sort: { createdAt: -1 }, // newest first
        };
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // get a parcel by parcel id

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }
        return res.send(parcel);
      } catch (error) {
        // console.error("Error catching parcel: ", error);
        res.status(500).send({ message: "Failed to fetch payment" });
      }
    });

    // post a parcel

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        // newParcel.createAt = new Date();
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel", error);
        res.status(500).send({ message: "Failed to Create Parcel" });
      }
    });

    // delete a parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel: ", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // patch rider & parcel

    app.patch("/parcels/:id/assign", async (req, res) => {
      const parcelId = req.params.id;
      const { riderId, riderName, assigned_rider_email } = req.body;

      try {
        // 1️⃣ Update parcel
        const parcelResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "in_transit",
              assigned_rider_id: riderId,
              assigned_rider_name: riderName,
              assigned_rider_email: assigned_rider_email,
            },
          }
        );
        // Update rider status
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "in_delivery",
            },
          }
        );

        res.send({ parcelResult, riderResult });
      } catch (error) {
        console.error("Assign rider error:", error);
        res.status(500).send({
          success: false,
          message: "Failed to assign rider",
        });
      }
    });

    // POST DELIVER STATUS

    app.patch("/parcels/:parcelId/deliver", async (req, res) => {
      try {
        const { parcelId } = req.params;
        const { riderId, message } = req.body;

        if (!parcelId || !riderId) {
          return res
            .status(400)
            .send({ message: "ParcelId and RiderId required" });
        }

        // 1️⃣ Update parcel → delivered
        const parcelResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "delivered",
            },
          }
        );

        // 2️⃣ Update rider → free
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "free",
            },
          }
        );

        res.send({
          success: true,
          parcelUpdated: parcelResult.modifiedCount,
          riderUpdated: riderResult.modifiedCount,
        });
      } catch (error) {
        console.error("Deliver parcel error:", error);
        res.status(500).send({ message: "Failed to deliver parcel" });
      }
    });

    // POST PICKUP DELIVERY

    app.patch("/parcels/:parcelId/pickup", async (req, res) => {
      try {
        const { parcelId } = req.params;
        const { riderId } = req.body;

        if (!parcelId || !riderId) {
          return res
            .status(400)
            .send({ message: "ParcelId and RiderId required" });
        }

        // 1️⃣ Update parcel → delivered
        const parcelResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "picked_up",
            },
          }
        );

        // 2️⃣ Update rider → free
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "busy",
            },
          }
        );

        res.send({
          success: true,
          parcelUpdated: parcelResult.modifiedCount,
          riderUpdated: riderResult.modifiedCount,
        });
      } catch (error) {
        console.error("Deliver parcel error:", error);
        res.status(500).send({ message: "Failed to deliver parcel" });
      }
    });

    // POST : RIDER APPLICATION starts here

    app.patch("/parcels/:id/cashout", async (req, res) => {
      const id = req.params.id;
      const result = await parcelCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: {
            cashout_status: "cashed_out",
            cashed_out_at: new Date(),
          },
        }
      );
      res.send(result);
    });

    app.get("/parcels/delivery/status-count", async (req, res) => {
      try {
        const pipeline = [
          {
            $group: {
              _id: "$delivery_status",
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              status: "$_id",
              count: 1,
            },
          },
        ];

        const result = await parcelCollection.aggregate(pipeline).toArray();
        res.send(result);
      } catch (error) {
        console.error("Status count error:", error);
        res.status(500).send({ message: "Failed to get status counts" });
      }
    });

    app.get("/parcels/pay/payment-count/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const pipeline = [
          {
            $match: { created_by: email }, // ✅ FILTER FIRST
          },
          {
            $group: {
              _id: "$payment_status",
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              status: "$_id",
              count: 1,
            },
          },
        ];

        const result = await parcelCollection.aggregate(pipeline).toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to get payment counts" });
      }
    });

    app.get("/parcels/delivery/status-count/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const pipeline = [
          {
            $match: {
              assigned_rider_email: email,
            },
          },
          {
            $group: {
              _id: "$delivery_status",
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              status: "$_id",
              count: 1,
            },
          },
        ];

        const result = await parcelCollection.aggregate(pipeline).toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to get payment counts" });
      }
    });

    // rider starts here :
    //

    // GET all active and deactive riders
    app.get("/riders/active-deactive", async (req, res) => {
      try {
        const riders = await ridersCollection
          .find({ status: { $in: ["active", "deactive"] } })
          .toArray();

        console.log("Riders fetched:", riders.length); // check server console
        res.send(riders);
      } catch (error) {
        console.error("Failed to load riders", error);
        res.status(500).send({ message: "FAILED TO LOAD RIDERS" });
      }
    });

    app.get(
      "/rider/completed_parcels",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res.status(400).send({ message: "Rider email required" });
          }
          const query = {
            assigned_rider_email: email,
            delivery_status: {
              $in: ["delivered", "service_center_delivered"],
            },
          };

          const options = {
            sort: { creation_date: -1 },
          };
          const completed_parcels = await parcelCollection
            .find(query, options)
            .toArray();

          // console.log(completed_parcels);
          res.send(completed_parcels);
        } catch (error) {
          console.error({ message: "completed_parcels error" });
        }
      }
    );

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // GET : PENDING RIDERS

    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        // console.log(pendingRiders);
        res.send(pendingRiders);
      } catch (error) {
        console.log("Failed to load pending riders", error);
        res.status(500).send({ message: "FAILED TO LOAD PENDING RIDERS" });
      }
    });

    // GET : ACTIVE RIDERS

    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: "active" })
          .toArray();
        res.send(activeRiders);
      } catch (error) {
        console.log("Failed to load active riders", error);
        res.status(500).send({ message: "FAILED TO LOAD ACTIVE RIDERS" });
      }
    });

    // PATCH : PENDING RIDERS UPDATE QUERY TO ACTIVE

    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email, work_status } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status, work_status },
      };
      try {
        const result = await ridersCollection.updateOne(query, updateDoc);
        res.send(result);

        // UPDATE USER ROLE IN USERSCOLLECTION

        if (status === "active") {
          const useQuery = { email };
          const userUpdateDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await usersCollection.updateOne(
            useQuery,
            userUpdateDoc
          );
          console.log(roleResult.modifiedCount);
        }
      } catch (error) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    // app get riders availabe

    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;
      try {
        const riders = await ridersCollection.find({ district }).toArray();
        res.send(riders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load messages" });
      }
    });

    // GET : RIDER PARCEL

    app.get("/riders/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        const query = {
          assigned_rider_email: email,
          delivery_status: { $in: ["in_transit", "picked_up"] },
        };

        const options = {
          sort: { creation_date: -1 },
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        // console.log(parcels);
        res.send(parcels);
      } catch (error) {
        console.error("Error occured on rider/parcels/", error);
        res.status(500).send({ message: "Failed to get rider tasks" });
      }
    });

    // POST : Record payment and update parcel status

    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        // 1. update parcel payment status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });
        }

        // 2. Insert Payment Record
        const paymentDoc = {
          parcelId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(), // FIXED
          paid_at: new Date(),
        };

        console.log(paymentDoc);

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        return res.status(201).send({
          message: "Payment recorded and marked as paid!",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment API Error:", error);
        return res.status(500).send({
          message: "Server error while processing payment",
          error: error.message,
        });
      }
    });

    // APP GET PAYMENTS

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "Forbidden Entry" });
        }
        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } };
        const payments = await paymentsCollection
          .find(query, options)
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("ERROR FETCHING PAYMENT HISTORY ; ", error);
        res.status(500).send({ message: "FAILED TO GET PAYMENTS" });
      }
    });

    // stripe payment intent

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { currency = "usd" } = req.body;
        const amountInCents = req.body.amountInCents;
        // const parcelId = req.body.parcelId;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: currency,
          payment_method_types: ["card"],
          // parcelId: parcelId,
        });

        res.json({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // tracking starts here

    app.post("/trackings", async (req, res) => {
      try {
        const update = req.body;

        if (!update.tracking_id || !update.status) {
          return res.status(400).json({
            message: "tracking_id and status are required",
          });
        }

        update.timestamp = new Date();

        const result = await trackingsCollection.insertOne(update);

        res.status(201).json({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Tracking insert error:", error);
        res.status(500).json({ message: "Failed to log tracking" });
      }
    });

    app.get("/trackings/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;
      const updates = await trackingsCollection
        .find({ tracking_id: trackingId })
        .sort({ Timestamp: 1 })
        .toArray();
      res.json(updates);
    });

    // code ends here ||

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

//sample route
app.get("/", (req, res) => {
  res.send("Zap-Shift Server is running\n");
});

//start the server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
