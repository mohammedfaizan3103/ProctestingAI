import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import About from "./pages/ContactUs";
import AdminFaculty from "./pages/AdminFaculty";
import AdminStudentsUpload from "./pages/AdminStudentsUpload";
import AdminUsers from "./pages/AdminUsers";
import FacultyExams from "./pages/FacultyExams";
import ExamEditor from "./pages/ExamEditor";
import FacultySubmissions from "./pages/FacultySubmissions";
import FacultyLiveView from "./pages/FacultyLiveView";
import StudentExams from "./pages/StudentExams";
import ExamRunner from "./pages/ExamRunner";
import StudentProfile from "./pages/StudentProfile";
import FacultyProfile from "./pages/FacultyProfile";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import FacultyLiveAlerts from "./components/FacultyLiveAlerts";
import PropTypes from "prop-types";

const PrivateRoute = ({ children }) =>
  localStorage.getItem("token") ? children : <Navigate to="/login" />;

const RoleRoute = ({ allow, children }) => {
  const stored = localStorage.getItem("user");
  if (!stored) return <Navigate to="/login" />;
  const user = JSON.parse(stored);
  return allow.includes(user.role) ? children : <Navigate to="/" />;
};

PrivateRoute.propTypes = {
  children: PropTypes.node.isRequired,
};

RoleRoute.propTypes = {
  allow: PropTypes.arrayOf(PropTypes.string).isRequired,
  children: PropTypes.node.isRequired,
};

function AppShell() {
  const location = useLocation();
  const hideNavbar = location.pathname.startsWith("/attempt/");
  const hideFooter = location.pathname.startsWith("/attempt/");
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {!hideNavbar && <Navbar />}
      <FacultyLiveAlerts />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<Login />} />
          <Route path="/about" element={<About />} />
          <Route path="/contactus" element={<Navigate to="/about" replace />} />
          <Route
            path="/dashboard"
            element={
              <PrivateRoute>
                <Dashboard />
              </PrivateRoute>
            }
          />
          <Route
            path="/admin/faculty"
            element={
              <PrivateRoute>
                <RoleRoute allow={["admin"]}>
                  <AdminFaculty />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <PrivateRoute>
                <RoleRoute allow={["admin"]}>
                  <AdminUsers />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/admin/students/upload"
            element={
              <PrivateRoute>
                <RoleRoute allow={["admin"]}>
                  <AdminStudentsUpload />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/faculty/exams"
            element={
              <PrivateRoute>
                <RoleRoute allow={["faculty"]}>
                  <FacultyExams />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/faculty/profile"
            element={
              <PrivateRoute>
                <RoleRoute allow={["faculty"]}>
                  <FacultyProfile />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/faculty/exams/new"
            element={
              <PrivateRoute>
                <RoleRoute allow={["faculty"]}>
                  <ExamEditor />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/faculty/exams/:id"
            element={
              <PrivateRoute>
                <RoleRoute allow={["faculty"]}>
                  <ExamEditor />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/faculty/exams/:examId/attempts"
            element={
              <PrivateRoute>
                <RoleRoute allow={["faculty"]}>
                  <FacultySubmissions />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/faculty/exams/:examId/live"
            element={
              <PrivateRoute>
                <RoleRoute allow={["faculty"]}>
                  <FacultyLiveView />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/exams"
            element={
              <PrivateRoute>
                <RoleRoute allow={["student"]}>
                  <StudentExams />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/student/profile"
            element={
              <PrivateRoute>
                <RoleRoute allow={["student"]}>
                  <StudentProfile />
                </RoleRoute>
              </PrivateRoute>
            }
          />
          <Route
            path="/attempt/:examId"
            element={
              <PrivateRoute>
                <RoleRoute allow={["student"]}>
                  <ExamRunner />
                </RoleRoute>
              </PrivateRoute>
            }
          />
        </Routes>
      </main>
      {!hideFooter && <Footer />}
    </div>
  );
}

function App() {
  return (
    <Router>
      <AppShell />
    </Router>
  );
}

export default App;
