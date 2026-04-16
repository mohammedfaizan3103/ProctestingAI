import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

// Auth middleware: validates JWT and attaches decoded payload
const auth = (req, res, next) => {
  const header = req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.split(" ")[1] : header;

  if (!token)
    return res.status(401).json({ msg: "No token, authorization denied" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ msg: "Invalid token" });
  }
};

// Role-based access control helper
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ msg: "Forbidden: insufficient role" });
    }
    next();
  };

// Backward-compatible export: default is auth; attach requireRole
auth.requireRole = requireRole;
export default auth;
